# openGym on Cloudflare Workers

The same API as `api/server.js`, on Cloudflare's free tier instead of a VPS running Docker
Compose. One Worker serves both the built frontend and `/api/*` — a single origin, which WebAuthn
requires and which is what nginx was doing in the Compose stack.

Upstream is unchanged and still works: `docker compose up -d` builds and runs the Node/nginx stack
exactly as before. This directory is an additional deployment target, not a replacement.

## What maps to what

| `api/server.js` | here |
| --- | --- |
| `http.createServer` | `export default { fetch }` + a `(req, res)` shim, so the route table is unchanged |
| nginx + static build | Workers static assets, `not_found_handling: single-page-application` |
| `db.json` | D1 tables `users`, `creds`, `subs`, `invites` |
| `state-<uid>.json` | D1 `state_chunks`, 64 KB per row |
| `data/audit.log` | D1 `audit` table |
| `data/secret`, `data/vapid.json` | Worker secrets |
| `setTimeout` rest timer | `RestTimer` Durable Object alarm |
| 10s reminder `setInterval` | Cron Trigger, `* * * * *` |
| `challenges` / `pairings` Maps | D1 rows with `exp`, swept on read |
| `presence` Map | D1 `presence` table, expired on read |
| `media/` volume (140 MB) | jsDelivr, pinned to the commit `build:mobile` already uses |

Deliberate behaviour differences:

- **Day reminders can be up to ~60s late.** Upstream scans every 10s to cap drift at ~9s; one
  minute is the finest granularity Cron Triggers offer.
- **The push SSRF guard is gone.** Upstream refuses push endpoints that resolve to a private
  address because its `api` container sits on the self-hoster's Docker network. A Worker has no
  private network to reach, so only the URL shape is still checked.
- **`ALLOW_GUEST` defaults off here** (`wrangler.jsonc` sets it), because this instance is
  invite-only. Upstream defaults it on.

## First deploy

Everything below is free-tier. You need a domain on Cloudflare — see *Why a custom domain* at the
bottom before substituting your own.

**1. Install and create the database**

```bash
cd worker && npm install
npx wrangler d1 create opengym
```

Copy the printed `database_id` into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

**2. Apply the schema**

```bash
npx wrangler d1 execute opengym --remote --file=schema.sql
```

**3. Generate and set the secrets**

Upstream generates these into `./data` on first boot. There is no filesystem here, so they are
Worker secrets and must be created once, up front. Losing `SESSION_SECRET` signs everyone out;
losing the VAPID keys invalidates every push subscription.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SESSION_SECRET
```

```bash
node -e "const k=require('web-push').generateVAPIDKeys();console.log(k.publicKey+'\n'+k.privateKey)"
```

Feed those two lines to `npx wrangler secret put VAPID_PUBLIC_KEY` and
`npx wrangler secret put VAPID_PRIVATE_KEY` respectively.

**4. Build the frontend**

```bash
cd ../frontend && npm install && npm run build:cloudflare
```

`build:cloudflare` points the exercise images and gifs at jsDelivr instead of the local `media/`
volume. These are **build-time** values baked into the bundle — setting them at runtime does
nothing.

**5. Deploy**

```bash
cd ../worker && npx wrangler deploy
```

**6. Attach the custom domain**

In the dashboard, Workers & Pages → `opengym` → Settings → Domains & Routes → add
`opengym.rcn.sh` as a Custom Domain. It must match `RP_ID` and `ORIGIN` in `wrangler.jsonc`
exactly.

## Bootstrapping the first account

There is a chicken-and-egg here that upstream has too, and it bites harder with `INVITE_ONLY=1`:
signing up needs an invite, creating an invite needs an admin, and being an admin needs an account.

Insert one invite by hand, register with it, then promote yourself:

```bash
npx wrangler d1 execute opengym --remote --command "INSERT INTO invites (code, note, created) VALUES ('$(node -e "console.log(require('crypto').randomBytes(8).toString('hex').toUpperCase())")','bootstrap',datetime('now'))"
```

Register in the browser with that code, then find your uid:

```bash
npx wrangler d1 execute opengym --remote --command "SELECT id, name FROM users"
```

Put it in `ADMIN_UIDS` in `wrangler.jsonc` and redeploy. From then on invites are managed from the
admin dashboard in the app.

## Local development

```bash
cd worker
npx wrangler d1 execute opengym --local --file=schema.sql
npx wrangler dev
```

Local secrets go in `worker/.dev.vars` (gitignored). For a local run set `RP_ID=localhost` and
`ORIGIN=http://localhost:8787` there — passkeys work over plain HTTP on localhost only.

## Free-tier limits worth watching

The numbers that actually constrain this, all per account per day, reset at 00:00 UTC. **Since
1 September 2026 D1 fails queries outright when the daily row limits are hit** rather than
degrading, so these are hard edges, not soft ones.

| Limit | Free plan | What spends it here |
| --- | --- | --- |
| D1 rows written | 100,000/day | Each `PUT /api/data` rewrites the user's state chunks. The frontend debounces syncs at 1500 ms, so an active workout writes on roughly every logged set. |
| D1 rows read | 5,000,000/day | The cron reads the `users` table once a minute (~1,440 × user count). |
| D1 database size | 500 MB | State blobs. |
| Worker requests | 100,000/day | The 20s live-workout heartbeat is the heaviest caller: 180/hour per user actively training. |
| Worker CPU | 10 ms/invocation | Passkey verification is the only expensive path; measured well under this. |
| Worker size | 3 MB | Currently ~954 KB, ~179 KB gzipped. |
| Cron Triggers | 5 per account | This uses one. |

`CHUNK` in `src/store.js` is the knob for the row-write cost: raising it means fewer, larger rows
per sync. It is 64 KB to stay clear of D1's 100 KB max SQL statement length as well as its 2 MB
max row size.

## Why a custom domain

WebAuthn binds a passkey to `RP_ID`, and **changing `RP_ID` later invalidates every passkey
already registered.** It must equal the hostname or be a registrable domain suffix of it, and it
must not itself be on the Public Suffix List — `workers.dev` is on that list, so a
`*.workers.dev` hostname can only ever be used as an exact-match `RP_ID`, permanently welded to a
name you do not control. A domain you own avoids both problems.
