# Book Club site (Cloudflare Pages + D1 + Access)

Static front end (`index.html`, `claude-shim.js`) + a Pages Function (`functions/api/[[path]].js`) backed by D1.
Sign-in is Cloudflare Access (email one-time PIN). Each person can edit only their own reviews, votes and profile; everything else is shared.

## Setup (once)
1. Cloudflare dashboard → Storage & Databases → D1 → create `bookclub`. Open its Console, paste `schema.sql`, run. Then paste your private `seed.sql` (past books/meetings) and run.
2. Workers & Pages → Create → Pages → Connect to Git → this repo. Build command: none. Output directory: `bhambookclub` (or set root to `bhambookclub`).
3. Pages project → Settings → Bindings → add D1 binding, variable name `DB` → `bookclub`.
4. Zero Trust → Access → Applications → Add self-hosted → your Pages domain. Policy: Allow, emails = your friends' addresses. Login method: One-time PIN. Copy the application's **AUD tag** and your team domain (`xxx.cloudflareaccess.com`).
5. Pages → Settings → Variables: `ACCESS_TEAM_DOMAIN` = team domain, `ACCESS_AUD` = AUD tag. Secret `ID_MAP` = `{"you@email.com":"u_57rBBjKReETUQOGVTHEdtg"}` so your existing reviews/attendance attach to you. Optional `ADMIN_EMAILS`.
6. Redeploy. Visit the site, sign in, pick your display name.

## Local tests
`node --no-warnings test.mjs` (needs Node 22; uses a seed.sql next to it).

`claude-artifact/index.html` is the original version for the Claude artifact runtime.

_Deployed on Cloudflare Pages._
