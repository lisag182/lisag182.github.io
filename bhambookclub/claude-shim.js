/* Emulates the Claude artifact `claude.use('db'|'user')` API on top of the Cloudflare Pages API. */
(function(){
  const API='/api/';
  const POLL_MS=4000;
  let rev=0, cache={}, subs={}, started=false, timer=null, lastErr=null;

  async function call(route,body){
    const opt=body===undefined?{method:'GET',credentials:'same-origin'}
      :{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-requested-with':'bookclub'},body:JSON.stringify(body)};
    const r=await fetch(API+route,opt);
    let j=null;try{j=await r.json()}catch(e){}
    if(r.status===401){location.reload();throw Object.assign(new Error('auth'),{code:'unauthenticated'})}
    if(!r.ok)throw Object.assign(new Error((j&&j.error&&j.error.message)||'error'),{code:(j&&j.error&&j.error.code)||'unavailable'});
    return j;
  }
  const clone=o=>JSON.parse(JSON.stringify(o));
  function snapOf(col){
    const m=cache[col]||{};
    return {docs:Object.keys(m).sort().map(id=>({id,data:()=>clone(m[id]),exists:true})),metadata:{fromCache:false}};
  }
  function notify(cols){
    cols.forEach(c=>(subs[c]||[]).forEach(f=>{try{f()}catch(e){}}));
  }
  async function refresh(force){
    const cols=Object.keys(subs);
    if(!cols.length)return;
    const r=await call('read',{rev:force?0:rev,cols});
    if(r.unchanged)return;
    rev=r.rev;
    const changed=[];
    cols.forEach(c=>{
      const next=r.cols[c]||{};
      if(JSON.stringify(next)!==JSON.stringify(cache[c]||null)||!(c in cache)){cache[c]=next;changed.push(c)}
    });
    notify(changed);
  }
  function start(){
    if(started)return;started=true;
    const tick=async()=>{
      if(!document.hidden){try{await refresh(false);lastErr=null}catch(e){lastErr=e;(subs.__err||[]).forEach(f=>f(e))}}
      timer=setTimeout(tick,POLL_MS);
    };
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(false).catch(()=>{})});
    tick();
  }
  function sub(col,docId,cb,errcb){
    const fire=()=>{
      if(!(col in cache))return;
      if(docId==null)cb(snapOf(col));
      else{const d=(cache[col]||{})[docId];cb({exists:d!==undefined,data:()=>d===undefined?undefined:clone(d),id:docId,metadata:{fromCache:false}})}
    };
    (subs[col]=subs[col]||[]).push(fire);
    if(errcb)(subs.__err=subs.__err||[]).push(errcb);
    // new column: fetch right away
    refresh(true).catch(e=>errcb&&errcb(e));
    start();
    return()=>{subs[col]=subs[col].filter(f=>f!==fire)};
  }
  function docRef(path){
    const [col,id]=path.split('/');
    const write=async(op,data)=>{
      const r=await call('write',{op,path,data});
      // apply locally for instant feedback, then reconcile on next poll
      cache[col]=cache[col]||{};
      if(op==='delete')delete cache[col][id];
      else if(op==='set')cache[col][id]=clone(data);
      else{const cur=cache[col][id]||{};cache[col][id]=Object.assign({},cur,clone(data))}
      notify([col]);rev=0;refresh(true).catch(()=>{});
      return r;
    };
    return{id,set:d=>write('set',d),update:d=>write('update',d),delete:()=>write('delete'),onSnapshot:(cb,err)=>sub(col,id,cb,err)};
  }
  function rid(){const a=new Uint8Array(9);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(36).padStart(2,'0')).join('').slice(0,12)}
  const db={
    doc:docRef,
    collection:col=>({onSnapshot:(cb,err)=>sub(col,null,cb,err),doc:id=>docRef(col+'/'+(id||rid()))})
  };

  let meP=null;
  function askName(suggested){
    return new Promise(res=>{
      const w=document.createElement('div');
      w.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:system-ui,sans-serif;padding:16px';
      w.innerHTML='<form style="background:#fff;color:#222;border-radius:14px;padding:24px;max-width:340px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.3)"><h2 style="margin:0 0 6px;font-size:20px">Welcome to book club 📚</h2><p style="margin:0 0 14px;font-size:14px;color:#555">What name should the club see?</p><input name="n" maxlength="60" required style="width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #bbb;border-radius:8px"><button style="margin-top:14px;width:100%;padding:11px;font-size:16px;border:0;border-radius:8px;background:#6b4f3a;color:#fff;cursor:pointer">Join</button></form>';
      document.body.appendChild(w);
      const inp=w.querySelector('input');inp.value=suggested||'';inp.focus();
      w.querySelector('form').onsubmit=e=>{e.preventDefault();const v=inp.value.trim();if(v){w.remove();res(v)}};
    });
  }
  async function me(){
    if(!meP)meP=(async()=>{
      let m=await call('me');
      if(!m.name){const n=await askName(m.suggested);m=await call('me',{name:n})}
      return m;
    })();
    return meP;
  }
  const names={};
  const user={
    id:async()=>(await me()).id,
    can:async()=>true,
    profiles:async ids=>{
      const need=ids.filter(i=>!(i in names));
      if(need.length){const r=await call('profiles',{ids:need});need.forEach(i=>{names[i]=r[i]||null})}
      const out={};ids.forEach(i=>{if(names[i])out[i]=names[i]});
      return out;
    }
  };
  window.claude={use:async k=>{if(k==='db')return db;if(k==='user')return user;throw new Error('unknown capability')}};
})();
