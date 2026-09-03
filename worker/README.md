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

## Deploying your own copy — read this first

`wrangler.jsonc` in this repo is a **live deployment config, not a template**: it holds the real
values for the instance at `opengym.rcn.sh`. Deploying it unchanged will fail, because it points
at a D1 database and a domain you do not own. Change these five things before you run anything:

| In `wrangler.jsonc` | Change to |
| --- | --- |
| `routes[0].pattern` | your hostname, or delete the `routes` block to deploy on `*.workers.dev` first |
| `d1_databases[0].database_id` | the id printed by `wrangler d1 create` in step 2 below |
| `vars.RP_ID` | your bare hostname, e.g. `gym.example.com` |
| `vars.ORIGIN` | the full URL, e.g. `https://gym.example.com`, no trailing slash |
| `name` | anything you like; it names the Worker |

`RP_ID` and `ORIGIN` must agree with the hostname you actually serve from, or every passkey
ceremony fails — and **changing `RP_ID` later invalidates every passkey already registered**, so
settle it before anyone signs up. See *Why a custom domain* at the bottom.

## First deploy

Everything below is free-tier.

**1. Install**

```bash
cd worker && npm install
```

On npm 11+ this stops with "packages have install scripts not yet covered by allowScripts".
Wrangler cannot run without them — `workerd` is the Cloudflare runtime and `esbuild` its bundler:

```bash
npm install-scripts approve workerd && npm install-scripts approve esbuild && npm install
```

**2. Create the database**

```bash
npx wrangler d1 create opengym
```

Copy the printed `database_id` into `wrangler.jsonc` as described above.

**3. Apply the schema**

```bash
npx wrangler d1 execute opengym --remote --file=schema.sql
```

**4. Generate and set the secrets**

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

**5. Build the frontend**

```bash
cd ../frontend && npm install && npm run build:cloudflare
```

`build:cloudflare` points the exercise images and gifs at jsDelivr instead of the local `media/`
volume. These are **build-time** values baked into the bundle — setting them at runtime does
nothing. The Worker serves `frontend/dist/` as static assets, so this must be built *before* you
deploy, and rebuilt whenever you change the frontend.

`sharp` and `fsevents` may report unapproved install scripts here. Neither is needed for
`vite build` — ignore them.

**6. Deploy**

```bash
cd ../worker && npx wrangler deploy
```

The `routes` block attaches your custom domain automatically, creating the DNS record for you, so
there is nothing to do in the dashboard. Two things to know:

- The token needs permission to write DNS in that zone. If the deploy reports an authentication
  error on the domain, add it by hand instead: Workers & Pages → your Worker → Settings →
  Domains & Routes → Custom Domain. Everything else still deployed.
- Adding a custom domain **disables the `workers.dev` route**, which is wanted: that would be a
  second origin your passkeys do not work on.

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

Then set it as a secret — **not** a var in `wrangler.jsonc`, which is public in this repo and
would name the admin account to anyone reading it:

```bash
printf 'YOUR_UID_HERE' | npx wrangler secret put ADMIN_UIDS
```

It takes effect immediately; no redeploy needed. Reload the app and the admin dashboard appears —
`ADMIN_UIDS` is read per request. From then on invites are managed from the admin dashboard.

`ADMIN_UIDS` is a comma-separated list, and admins are matched by uid rather than name, so
renaming an account does not change who is an admin.

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

## Notifications, and what actually uses this server

Two things are easy to conflate, and only one of them touches the Worker.

**Web push (browser)** goes through this server: the browser registers with its push service,
`POST /api/push/subscribe` stores the endpoint, and rest-timer alerts and day reminders are sent
from the Durable Object alarm and the cron respectively.

**The native Android/iOS app does not.** On the Capacitor build the reminder is an OS-scheduled
local notification (`frontend/src/lib/mobile.js`), so it never creates a subscription and never
reaches the cron. A phone using the app will show `subs: 0` and still get its reminders. That is
correct, not a fault.

Two failure modes worth knowing before you debug a "push is broken" report:

- **De-Googled Chromium browsers cannot do web push at all.** Ungoogled-chromium and forks built
  on it (Helium, for one) strip the Google API keys that FCM registration needs, so
  `pushManager.subscribe()` fails with "Registration failed - push service error". Nothing
  server-side can fix it; Firefox uses Mozilla's push service and works fine.
- **A day reminder only fires on days with a routine planned.** `effectiveRoutineId` returns null
  otherwise and the cron skips the user, so a brand-new account with no routines will never get
  one however the reminder is configured. Settings says so in its footer, quietly.

To test delivery without waiting on any of that, use the test button in Settings → Notifications
(`POST /api/push/test`), which sends immediately and needs no routine or schedule.

## Why a custom domain

WebAuthn binds a passkey to `RP_ID`, and **changing `RP_ID` later invalidates every passkey
already registered.** It must equal the hostname or be a registrable domain suffix of it, and it
must not itself be on the Public Suffix List — `workers.dev` is on that list, so a
`*.workers.dev` hostname can only ever be used as an exact-match `RP_ID`, permanently welded to a
name you do not control. A domain you own avoids both problems.
