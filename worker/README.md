# openGym on Cloudflare Workers

Runs openGym on Cloudflare's free tier instead of a VPS with Docker Compose. One Worker serves
both the built frontend and the `/api/*` routes, so everything is a single origin — which WebAuthn
requires, and which is the job nginx was doing in the Compose stack.

This fork has no other deployment target: the Compose stack is gone, and `api/` is kept only to
diff against upstream ([api/README.md](../api/README.md)). The Worker's source lives in
[`src/`](src) and its schema in [`migrations/`](migrations), but its **configuration lives at the
repository root** — `wrangler.jsonc` and `instance.jsonc` — because a Deploy to Cloudflare button
aimed at a subdirectory would make that subdirectory the entire repository, leaving no `frontend/`
to build. See [docs/CONFIG.md](../docs/CONFIG.md).

**What you get:** passkey login, cross-device sync, the admin dashboard, invite codes, the audit
log, web push, rest-timer alerts and day reminders — the whole application, for £0, with no server
to patch.

**What it costs you:** a domain you control (see [Why you need a domain](#why-you-need-a-domain)),
and about fifteen minutes.

---

## Before you start

Three decisions, in order of how expensive they are to change.

**1. Your hostname is close to permanent.** A passkey is cryptographically bound to `RP_ID`, the
bare hostname it was registered on. **Changing `RP_ID` later invalidates every passkey anyone has
registered** — they lose access and must re-register. Pick the hostname you intend to keep.

**2. It cannot be a `*.workers.dev` subdomain.** `workers.dev` is on the Public Suffix List, so
`RP_ID` can only ever be the exact full hostname, permanently tied to a name Cloudflare controls
rather than you. Use a domain on your own Cloudflare account.

**3. `instance.jsonc` is a live config, not a template.** `wrangler.jsonc` is generic and
deployable by anyone; `instance.jsonc` beside it holds the real values for the instance at
`opengym.rcn.sh`, and deploying *that* unchanged fails, because it points at a database and a
domain you do not own. Change these first:

| In `instance.jsonc` | Change to |
| --- | --- |
| `name` | whatever you want the Worker called |
| `routes[0].pattern` | your hostname — or delete the whole `routes` block to try it on `*.workers.dev` first |
| `d1_databases[0].database_id` | the id printed by step 2 below |
| `vars.RP_ID` | your bare hostname, e.g. `gym.example.com` |
| `vars.ORIGIN` | the full URL, e.g. `https://gym.example.com` — no trailing slash |

Every other setting has a working default, so anything you leave out is a default you accepted.
[docs/CONFIG.md](../docs/CONFIG.md) lists them all.

`RP_ID`, `ORIGIN` and the hostname you actually serve from must all agree. If they don't, every
passkey ceremony fails with an origin mismatch.

---

## Deploy

**1. Install**

```bash
npm install
```

From the repository root — that is where `wrangler.jsonc` and the Worker's dependencies live.

On npm 11+ this stops with *"packages have install scripts not yet covered by allowScripts"*.
Wrangler cannot run without them — `workerd` is Cloudflare's runtime and `esbuild` its bundler:

```bash
npm install-scripts approve workerd && npm install-scripts approve esbuild && npm install
```

**2. Create the database**

```bash
npx wrangler d1 create opengym
```

Copy the printed `database_id` into `instance.jsonc`.

**3. Create the tables**

```bash
npx wrangler d1 migrations apply DB --remote
```

`npm run deploy` does this for you on every deploy, so this step is only needed if you want the
tables before the first one. Migrations are `IF NOT EXISTS` throughout and safe to re-run.

**4. Set the secrets**

Upstream generates these into `./data` on first boot. There is no filesystem here, so they are
Worker secrets and must be created up front. **Losing `SESSION_SECRET` signs everyone out; losing
the VAPID keys invalidates every push subscription.** Back them up somewhere.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SESSION_SECRET
```

```bash
node -e "const k=require('web-push').generateVAPIDKeys();console.log(k.publicKey+'\n'+k.privateKey)"
```

Feed the first printed line to `npx wrangler secret put VAPID_PUBLIC_KEY` and the second to
`npx wrangler secret put VAPID_PRIVATE_KEY`.

**5. Build the frontend**

```bash
npm run build
```

The Worker serves `frontend/dist/` as static assets, so this must happen **before** you deploy,
and again whenever you change the frontend. `build:cloudflare` points the ~140 MB of exercise
images and GIFs at jsDelivr rather than the local `media/` volume; those are build-time values
baked into the bundle, so setting them at runtime does nothing.

(`sharp` and `fsevents` may report unapproved install scripts here. Neither is used by
`vite build` — ignore them.)

**6. Deploy**

```bash
npm run deploy:instance
```

That merges `instance.jsonc` over `wrangler.jsonc`, applies any pending migrations and deploys the
result. `npm run deploy` does the same with the generic config alone, ignoring `instance.jsonc`.

The `routes` block attaches your custom domain and creates the DNS record, so there is nothing to
do in the dashboard. Two things to know:

- Your token needs DNS write permission on that zone. If the deploy reports an authentication
  error *on the domain specifically*, everything else still deployed — add the domain by hand:
  Workers & Pages → your Worker → Settings → Domains & Routes → Custom Domain.
- Attaching a custom domain **disables the `workers.dev` route.** That is wanted: it would
  otherwise be a second origin your passkeys do not work on.

---

## Create the first account

There is a chicken-and-egg problem, and `INVITE_ONLY=1` makes it worse: signing up needs an
invite, minting an invite needs an admin, and being an admin needs an account.

Break it by inserting one invite by hand:

```bash
npx wrangler d1 execute DB --remote --command "INSERT INTO invites (code, note, created) VALUES ('$(node -e "console.log(require('crypto').randomBytes(8).toString('hex').toUpperCase())")','bootstrap',datetime('now'))"
```

That prints the code it inserted. Register in a browser with it, then find your uid:

```bash
npx wrangler d1 execute DB --remote --command "SELECT id, name FROM users"
```

Make yourself an admin — as a **secret**, not a var in `instance.jsonc`, which is public in this
repo and would name the admin account to anyone reading it:

```bash
printf 'YOUR_UID_HERE' | npx wrangler secret put ADMIN_UIDS
```

No redeploy needed; `ADMIN_UIDS` is read per request, so reload the app and the admin dashboard
appears. From then on invites are managed in-app.

`ADMIN_UIDS` is comma-separated, and admins are matched by uid rather than name, so renaming an
account does not change who is an admin.

---

## Local development

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

Local secrets go in `.dev.vars` at the repository root (gitignored) — copy `.dev.vars.example`.
Set `RP_ID=localhost` and `ORIGIN=http://localhost:8787` there; passkeys work over plain HTTP on
localhost, and nowhere else. `.dev.vars` also overrides `vars`, which is how local runs pick up
settings the generic `wrangler.jsonc` leaves at their defaults.

There is an integration test covering everything the passkey ceremony sits in front of — session
verification and revocation, the chunked state round-trip, presence, invites, the admin routes and
the audit log. It mints its own session cookies, so it needs a seeded user and `ADMIN_UIDS` in
`.dev.vars`:

```bash
npx wrangler d1 execute DB --local --command \
  "INSERT OR REPLACE INTO users (id,name,created) VALUES ('testuid000001','tester','2026-01-01T00:00:00.000Z')"
npm run test:smoke
```

It also needs `INVITE_ONLY=1` in `.dev.vars` for the invite assertions, and it is not idempotent:
`logout/all` bumps the seeded user's session version, so a second run against the same local
database needs `UPDATE users SET sv=0`.

`npm test` is the fast half — the push-notification copy, the passkey error message, and the
config merge that decides which hostname and database a deploy lands on.

CI (`.github/workflows/worker.yml`) runs both, plus a dry-run bundle of each config, on every push
touching the Worker, with no Cloudflare credentials.

---

## Continuous deployment

This instance uses [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/):
pushing to `main` builds and deploys automatically. Set it up after your first manual deploy —
the Worker has to exist before you can connect a repository to it — and it authorises through a
GitHub App in the dashboard, so no Cloudflare API token is stored in this repository.

Workers & Pages → your Worker → Settings → Builds → Build configuration:

| Field | Value |
| --- | --- |
| Root directory | *blank* — the repository root |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:instance` |
| Version command | `npm run upload:instance` |

There are two triggers behind that one panel: **Deploy command** runs on the production branch,
**Version command** on every other branch. The dashboard does not say so, and it is the reason a
pull request can fail while `main` is configured correctly.

Root directory is *not* `worker` any more: `wrangler.jsonc` and the Worker's dependencies live at
the repository root, for the reason at the top of this file. Leaving it set to `worker` mostly
still works by accident — npm walks up to find the root manifest, and so does wrangler — but
wrangler walking up is exactly what makes it load the generic config instead of the merged one.

The build command is not optional: `frontend/dist` is gitignored, so without it the build fails
with *"the directory specified by the assets.directory field does not exist"*.

The deploy command matters just as much. Plain `npx wrangler deploy` deploys the **generic**
config — no custom domain, `RP_ID` of `localhost`, and a placeholder database id. In practice it
does not silently ship that: the placeholder id fails validation with *"D1 binding 'DB'
references database '00000000-…' which was not found"*, so the build stops rather than replacing
a working instance. But it does mean nothing deploys until the command is right.
`npm run deploy:instance` folds `instance.jsonc` back in, applying pending migrations first.
`npm run upload:instance` is the branch-build equivalent: it uploads a version against the real
bindings without deploying it or touching the database.

Free plan gives 3,000 build minutes a month; a build here takes about two.

Worth knowing:

- **Every push to `main` deploys**, including documentation-only commits. The GitHub Actions
  workflow runs alongside it, not as a gate — a commit that fails the smoke test still ships.
  If that matters to you, point the production branch at a release branch instead.
- **Your secrets are untouched by deploys.** `SESSION_SECRET`, the VAPID keys and `ADMIN_UIDS`
  live outside the code and vars, so redeploying never signs anyone out or breaks push.
- **Preview URLs are not generated**, because this Worker implements a Durable Object
  (`RestTimer`). Branch builds still run `wrangler versions upload` and validate the change; you
  just do not get a clickable preview link.

To deploy by hand anyway — for a rollback, or before the repository is connected — the steps in
[Deploy](#deploy) still work. Remember to rebuild the frontend first if you touched it.

---

## How it works

The route table, request and response shapes and audit events are unchanged from `api/server.js`.
A small `(req, res)` shim lets the handlers stay written against `node:http`, so upstream releases
remain a line-for-line comparison rather than a manual merge. What changed is underneath:

| `api/server.js` | here |
| --- | --- |
| `http.createServer` | `export default { fetch }` plus a `(req, res)` shim |
| nginx + static build | Workers static assets, `not_found_handling: single-page-application` |
| `db.json` | D1 tables `users`, `creds`, `subs`, `invites` |
| `state-<uid>.json` | D1 `state_chunks`, 64 KB per row |
| `data/audit.log` | D1 `audit` table |
| `data/secret`, `data/vapid.json` | Worker secrets |
| `setTimeout` rest timer | `RestTimer` Durable Object alarm |
| 10s reminder `setInterval` | Cron Trigger, once a minute |
| `challenges` / `pairings` Maps | D1 rows with `exp`, swept on read and by the cron |
| `presence` Map | D1 `presence` table, expired on read |
| `media/` volume (140 MB) | jsDelivr, pinned to the commit `build:mobile` already uses |

`node:crypto` works unchanged under Workers' Node compatibility, so session signing is identical
to upstream. `web-push` is used only for `generateRequestDetails()` — its VAPID JWT and RFC 8291
payload encryption — and the request goes out over `fetch`, never `node:https`.

**Deliberate differences from upstream:**

- **Day reminders can be up to ~60s late.** Upstream scans every 10 seconds to cap drift at ~9s;
  one minute is the finest granularity Cron Triggers offer.
- **The push SSRF guard is gone.** Upstream refuses push endpoints resolving to private addresses,
  because its `api` container sits on the self-hoster's Docker network. A Worker has no private
  network to reach, so only the URL shape is checked.
- **`ALLOW_GUEST` defaults off** in this config. Upstream defaults it on.

---

## Notifications

Two things are easy to conflate, and only one touches this server.

**Web push (browser)** goes through the Worker: the browser registers with its push service,
`POST /api/push/subscribe` stores the endpoint, and rest-timer alerts and day reminders are sent
from the Durable Object alarm and the cron.

**The native Android/iOS app does not.** On the Capacitor build the reminder is an OS-scheduled
local notification (`frontend/src/lib/mobile.js`). It never creates a subscription and never
reaches the cron, so a phone using the app shows `subs: 0` and still gets its reminders. That is
correct, not a fault.

Before debugging a "push is broken" report, rule these out:

- **De-Googled Chromium browsers cannot do web push at all.** Ungoogled-chromium and forks built
  on it strip the Google API keys FCM registration needs, so `pushManager.subscribe()` fails with
  *"Registration failed - push service error"*. Nothing server-side fixes it. Firefox uses
  Mozilla's push service and works.
- **A day reminder only fires on days with a routine planned.** `effectiveRoutineId` returns null
  otherwise and the cron skips that user, so a new account with no routines never gets one however
  the reminder is configured.

To test delivery without any of that, use the test button in Settings → Notifications
(`POST /api/push/test`). It sends immediately and needs no routine or schedule.

---

## Free-tier limits worth watching

All per account per day, resetting at 00:00 UTC. **Since 1 September 2026 D1 fails queries
outright when the daily row limits are hit** rather than degrading, so these are hard edges.
They are also per *account*, not per database — other Workers on the same account share them.

| Limit | Free plan | What spends it here |
| --- | --- | --- |
| D1 rows written | 100,000/day | Every `PUT /api/data` rewrites that user's state chunks. The frontend debounces at 1500 ms, so an active workout writes roughly once per logged set. |
| D1 rows read | 5,000,000/day | The cron reads the `users` table once a minute. |
| D1 database size | 500 MB | State blobs. |
| Worker requests | 100,000/day | The 20s live-workout heartbeat is heaviest: 180/hour per user actively training. |
| Worker CPU | 10 ms/invocation | Passkey verification is the only expensive path; measured well under. |
| Worker size | 3 MB | Currently ~954 KB, ~179 KB gzipped. |
| Cron Triggers | 5 per account | This uses one. |

`CHUNK` in `src/store.js` is the knob for the write cost — larger chunks mean fewer rows per sync.
It is 64 KB to stay clear of D1's 100 KB maximum SQL statement length as well as its 2 MB maximum
row size.

---

## Why you need a domain

WebAuthn binds a passkey to `RP_ID`. That must equal the hostname or be a registrable domain
suffix of it, and it must not itself appear on the Public Suffix List.

`workers.dev` **is** on that list. So a `*.workers.dev` hostname can only be used as an
exact-match `RP_ID` — and since changing `RP_ID` invalidates every passkey ever registered, that
welds your users' credentials to a hostname you do not own and cannot move. A domain on your own
Cloudflare account avoids both problems, and the DNS record is created for you at deploy time.
