// Cloudflare Pages Function: JSON API for the book club, backed by D1.
// Auth: Cloudflare Access (verified JWT). Bindings/vars: DB (D1), ACCESS_TEAM_DOMAIN, ACCESS_AUD,
// optional ID_MAP (secret JSON {"email":"legacy-id"}), optional ADMIN_EMAILS (comma list).
// DEV_EMAIL is honored ONLY for requests to localhost (local testing).

const COLS = new Set(['books', 'meetings', 'polls', 'schedules', 'members', 'reviews', 'ballots', 'people', 'club']);
const SELF_COLS = new Set(['ballots', 'reviews', 'members']); // each person writes only their own doc
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 256 * 1024;
const enc = new TextEncoder();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, code, message) => json({ error: { code, message } }, status);

/* ---------- base64url + JWT ---------- */
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64uToStr = s => new TextDecoder().decode(b64uToBytes(s));
function bytesToB64u(b) {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const normTeam = t => String(t || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

let jwksCache = { team: '', at: 0, keys: null };
async function getJwks(team) {
  if (jwksCache.team === team && jwksCache.keys && Date.now() - jwksCache.at < 600000) return jwksCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('jwks fetch failed');
  const j = await r.json();
  jwksCache = { team, at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}

export async function verifyAccessJwt(token, env, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('format');
  const [h, p, s] = parts;
  const header = JSON.parse(b64uToStr(h)), payload = JSON.parse(b64uToStr(p));
  if (header.alg !== 'RS256') throw new Error('alg');
  const team = normTeam(env.ACCESS_TEAM_DOMAIN), aud = env.ACCESS_AUD;
  if (!team || !aud) throw new Error('not configured');
  const keys = await getJwks(team);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(s), enc.encode(h + '.' + p));
  if (!ok) throw new Error('signature');
  const t = Math.floor(now / 1000);
  if (!payload.exp || payload.exp < t) throw new Error('expired');
  if (payload.nbf && payload.nbf > t + 60) throw new Error('not yet valid');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('audience');
  if (payload.iss && payload.iss !== `https://${team}`) throw new Error('issuer');
  if (!payload.email) throw new Error('no email');
  return String(payload.email).toLowerCase();
}

async function authenticate(request, env) {
  const host = new URL(request.url).hostname;
  if (env.DEV_EMAIL && (host === 'localhost' || host === '127.0.0.1')) return String(env.DEV_EMAIL).toLowerCase();
  let tok = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!tok) {
    const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') || '');
    if (m) tok = m[1];
  }
  if (!tok) return null;
  try { return await verifyAccessJwt(tok, env); } catch (e) { return null; }
}

async function userIdFor(email, env) {
  if (env.ID_MAP) {
    try {
      const m = JSON.parse(env.ID_MAP);
      for (const k of Object.keys(m)) if (k.toLowerCase() === email) return String(m[k]);
    } catch (e) { /* ignore bad ID_MAP */ }
  }
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('bookclub:' + email)));
  return 'u_' + bytesToB64u(d).slice(0, 22);
}
const isAdminEmail = (email, env) => String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).includes(email);

/* ---------- helpers ---------- */
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function mergeDeep(target, patch) {
  const out = { ...target };
  for (const k of Object.keys(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const v = patch[k];
    if (isObj(v) && Object.keys(v).length === 1 && v.__delete__ === true) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = mergeDeep(out[k], v);
    else out[k] = v;
  }
  return out;
}
function parseDocPath(path) {
  const s = String(path || '').split('/');
  if (s.length !== 2 || !s.every(x => SEG.test(x)) || !COLS.has(s[0])) return null;
  return s;
}
const getRev = async env => { const r = await env.DB.prepare("SELECT v FROM meta WHERE k='rev'").bind().first(); return r ? r.v : 1; };
const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
function suggestName(email) {
  const w = email.split('@')[0].split(/[._+\-]/)[0].replace(/[0-9]+$/, '');
  return w ? w[0].toUpperCase() + w.slice(1) : '';
}

/* ---------- routes ---------- */
async function routeMe(env, email, uid, method, body) {
  let row = await env.DB.prepare('SELECT name FROM profiles WHERE id=?').bind(uid).first();
  if (method === 'POST') {
    const name = cleanName(body && body.name);
    if (!name) return fail(400, 'invalid_argument', 'Please enter a name.');
    await env.DB.prepare('INSERT INTO profiles(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
      .bind(uid, name, Date.now()).run();
    return json({ id: uid, name });
  }
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO profiles(id,name,created_at) VALUES(?,NULL,?)').bind(uid, Date.now()).run();
    row = { name: null };
  }
  return json({ id: uid, name: row.name || null, suggested: suggestName(email) });
}

async function routeProfiles(env, body) {
  const ids = (Array.isArray(body && body.ids) ? body.ids : []).filter(x => typeof x === 'string' && SEG.test(x)).slice(0, 200);
  const out = {};
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT id,name FROM profiles WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    for (const r of results) if (r.name) out[r.id] = { name: r.name };
  }
  return json(out);
}

async function routeRead(env, body) {
  const rev = await getRev(env);
  if (body && body.rev === rev) return json({ rev, unchanged: true });
  const cols = {};
  for (const c of (Array.isArray(body && body.cols) ? body.cols : []).slice(0, 20)) {
    if (!COLS.has(c)) continue;
    const { results } = await env.DB.prepare('SELECT id,data FROM docs WHERE col=?').bind(c).all();
    cols[c] = {};
    for (const r of results) cols[c][r.id] = JSON.parse(r.data);
  }
  return json({ rev, cols });
}

async function routeWrite(env, uid, isAdmin, body) {
  const op = body && body.op, pp = parseDocPath(body && body.path);
  if (!pp || !['set', 'update', 'delete'].includes(op)) return fail(400, 'invalid_argument', 'Bad request.');
  const [col, id] = pp, path = col + '/' + id;
  if (SELF_COLS.has(col) && id !== uid && !isAdmin) return fail(403, 'permission_denied', 'You can only change your own entries.');
  const bump = env.DB.prepare("UPDATE meta SET v=v+1 WHERE k='rev'").bind();
  if (op === 'delete') {
    await env.DB.batch([env.DB.prepare('DELETE FROM docs WHERE path=?').bind(path), bump]);
    return json({ rev: await getRev(env) });
  }
  if (!isObj(body.data)) return fail(400, 'invalid_argument', 'Data must be an object.');
  const existing = await env.DB.prepare('SELECT data,version FROM docs WHERE path=?').bind(path).first();
  let next;
  if (op === 'set') next = body.data;
  else {
    if (!existing) return fail(400, 'invalid_argument', 'Document does not exist.');
    next = mergeDeep(JSON.parse(existing.data), body.data);
  }
  const text = JSON.stringify(next);
  if (text.length > MAX_DOC) return fail(400, 'invalid_argument', 'Document too large.');
  const version = (existing ? existing.version : 0) + 1;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO docs(path,col,id,data,version,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at')
      .bind(path, col, id, text, version, Date.now()),
    bump,
  ]);
  return json({ rev: await getRev(env), version });
}

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (!env.DB) return fail(500, 'unavailable', 'Database is not connected.');
    const email = await authenticate(request, env);
    if (!email) return fail(401, 'unauthenticated', 'Please sign in.');
    const route = new URL(request.url).pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
    const method = request.method;
    let body = null;
    if (method === 'POST') {
      if (request.headers.get('x-requested-with') !== 'bookclub') return fail(403, 'forbidden', 'Bad request origin.');
      const len = +request.headers.get('content-length') || 0;
      if (len > 1024 * 1024) return fail(413, 'invalid_argument', 'Too large.');
      try { body = await request.json(); } catch (e) { return fail(400, 'invalid_argument', 'Bad JSON.'); }
    } else if (method !== 'GET') return fail(405, 'invalid_argument', 'Method not allowed.');
    const uid = await userIdFor(email, env);
    if (route === 'me') return routeMe(env, email, uid, method, body);
    if (method !== 'POST') return fail(404, 'not_found', 'Not found.');
    if (route === 'profiles') return routeProfiles(env, body);
    if (route === 'read') return routeRead(env, body);
    if (route === 'write') return routeWrite(env, uid, isAdminEmail(email, env), body);
    return fail(404, 'not_found', 'Not found.');
  } catch (e) {
    return fail(500, 'unavailable', 'Something went wrong.');
  }
}
