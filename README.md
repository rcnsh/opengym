# openGym on Cloudflare

A Cloudflare port of [openGym](https://gitlab.com/DuarteSantos8/opengym) by Duarte Santos, a
self-hosted gym and body-weight tracker. This fork runs the same app as one Cloudflare Worker with
D1, instead of upstream's Node server and Docker Compose stack.

- Upstream: <https://gitlab.com/DuarteSantos8/opengym> (the original project, its issues, its
  demo site and its Android APK)
- Licence: [AGPL-3.0-or-later](LICENSE), same as upstream. Third-party notices, including the
  exercise media, are in [NOTICE.md](NOTICE.md).
- Full feature list and the previous README: [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)

<!-- TODO: add screenshot/GIF at docs/screenshot.png -->
<!-- <img src="docs/screenshot.png" alt="openGym running on Cloudflare" width="720"> -->

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rcnsh/opengym)

## What differs from upstream

| Upstream | This fork |
| --- | --- |
| Node `http` server (`api/server.js`) | Worker in `worker/src/`, same route table behind a `(req, res)` shim |
| nginx serving the built frontend | Workers static assets from `frontend/dist/` |
| JSON files in `./data` | D1 database (`DB` binding) |
| Secrets generated into `./data` on first boot | Worker secrets, set by you |
| `setTimeout` rest timer | `RestTimer` Durable Object alarm |
| 10 s reminder loop | Cron Trigger, every minute (reminders up to ~60 s late) |
| Exercise media in a local `media/` volume | jsDelivr, pinned to a commit at build time |
| Docker Compose | Removed. Cloudflare is the only deployment target |

`api/server.js` is kept only to diff against upstream releases. It is not deployed or runnable;
see [api/README.md](api/README.md). Details of the port: [ARCHITECTURE.md](ARCHITECTURE.md) and
[worker/README.md](worker/README.md#how-it-works).

## Requirements

- Node.js 22 (what CI uses) and npm
- For deployment: a Cloudflare account and a domain on it. Passkeys are bound to the hostname, and
  `*.workers.dev` cannot be moved off later ([why](worker/README.md#why-you-need-a-domain)).

## Quickstart

Runs the Worker locally with a local D1 database. Nothing is created on Cloudflare.

```bash
git clone https://github.com/rcnsh/opengym && cd opengym
npm install
cp .dev.vars.example .dev.vars        # then set SESSION_SECRET, e.g. `openssl rand -hex 32`
npm run build                         # builds frontend/dist, which the Worker serves
npx wrangler d1 migrations apply DB --local
npm run dev                           # http://localhost:8787
```

The API refuses every request until `SESSION_SECRET` is set. The defaults in `wrangler.jsonc`
(`RP_ID=localhost`, `ORIGIN=http://localhost:8787`) already match local dev; passkeys work over
plain HTTP on `localhost` only.

On npm 11, if install stops on unapproved install scripts for `workerd` or `esbuild`:

```bash
npm install-scripts approve workerd && npm install-scripts approve esbuild && npm install
```

## Configuration

Full reference: [docs/CONFIG.md](docs/CONFIG.md). Three places:

| | Where | In git |
| --- | --- | --- |
| Generic config: bindings, cron, compatibility date | `wrangler.jsonc` | yes |
| One deployment: route, D1 id, `RP_ID`/`ORIGIN`, policy vars | `instance.jsonc` | yes |
| Secrets | `wrangler secret put`, or `.dev.vars` locally | no |

`instance.jsonc` holds the values for this repo's own instance. If you fork, replace them.

### Bindings

| Binding | Type | Used for |
| --- | --- | --- |
| `DB` | D1 | users, passkeys, push subscriptions, invites, per-user state, audit log |
| `REST_TIMER` | Durable Object (`RestTimer`, SQLite-backed) | rest-timer push alerts, one object per user |
| `ASSETS` | Static assets (`frontend/dist/`) | the built frontend; `/api/*` runs the Worker first |
| Cron `* * * * *` | Trigger | workout-day reminders; sweeps expired presence, challenges and pairing codes; hourly audit-log compaction |

### Variables

Set in `vars`. Defaults are in [`worker/src/runtime.js`](worker/src/runtime.js).

| Variable | Default | Notes |
| --- | --- | --- |
| `RP_ID` | `localhost` | Bare hostname for passkeys. Changing it invalidates every passkey |
| `ORIGIN` | `http://localhost:8787` | Full URL, no trailing slash. Must match `RP_ID` |
| `RP_NAME` | `openGym` | Shown in the passkey prompt |
| `SESSION_DAYS` | `90` | Sign-in lifetime |
| `INVITE_ONLY` | off | `1` to require an invite code |
| `ALLOW_GUEST` | on | `0` to hide "Continue without account" |
| `AUDIT_LOG` | on | `0` to disable the activity log |
| `AUDIT_MAX` | `5000` | Events kept; `0` for no limit |
| `AUDIT_DAYS` | `0` | Days kept; `0` for no age limit |
| `AUDIT_IP` | `net` | `off`, `net` or `full` |
| `VAPID_SUBJECT` | `ORIGIN` if HTTPS, else `mailto:admin@localhost` | Contact sent with push |

### Secrets

| Secret | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | yes | Signs session cookies. Losing it signs everyone out |
| `VAPID_PUBLIC_KEY` | no | Web Push key pair (`npx web-push generate-vapid-keys`). Leave both unset to run without push |
| `VAPID_PRIVATE_KEY` | no | Losing the pair breaks every push subscription |
| `ADMIN_UIDS` | no | Comma-separated user ids with the admin dashboard. Read per request |

Cloudflare cannot show a secret again after it is set. Keep a copy.

### Build-time values

Baked into the frontend bundle by Vite, so setting them in `vars` does nothing.

| Variable | Set by | Notes |
| --- | --- | --- |
| `VITE_IMG_BASE`, `VITE_GIF_BASE` | `npm run build` (`build:cloudflare` in `frontend/`) | Exercise media URLs, pinned jsDelivr commit |
| `VITE_MOBILE` | `build:mobile` | Capacitor build, see [docs/MOBILE.md](docs/MOBILE.md) |
| `VITE_DEMO` | not set by any script here | Upstream's public demo build |
| `VITE_UMAMI_SRC`, `VITE_UMAMI_ID` | not set by any script here | Optional analytics, injected only if both are set |

The Vite dev server also reads `API_TARGET`, `API_ORIGIN` and `MEDIA_TARGET` (see
[CONTRIBUTING.md](CONTRIBUTING.md)). The optional MCP server reads `OPENGYM_URL`, `OPENGYM_TOKEN`,
`OPENGYM_UID` and `OPENGYM_DATA` ([mcp/README.md](mcp/README.md)).

## Deployment

Deployment uses Wrangler through the npm scripts. `cf deploy` does not read this project's
`wrangler.jsonc` (it detects a static site and drops the D1, Durable Object and cron bindings),
and the `instance.jsonc` merge is Wrangler-specific, so keep to the commands below.

```bash
npm install
npx wrangler d1 create opengym              # copy the printed database_id into instance.jsonc
$EDITOR instance.jsonc                      # name, routes, database_id, RP_ID, ORIGIN, policy vars
npx wrangler secret put SESSION_SECRET
npx wrangler secret put VAPID_PUBLIC_KEY    # optional
npx wrangler secret put VAPID_PRIVATE_KEY   # optional
npm run build
npm run deploy:instance                     # merge, apply D1 migrations, deploy
```

| Script | Does |
| --- | --- |
| `npm run deploy` | Migrates and deploys `wrangler.jsonc` alone. Used by the Deploy to Cloudflare button |
| `npm run config` | Writes `wrangler.instance.json` (`instance.jsonc` merged over `wrangler.jsonc`) |
| `npm run deploy:instance` | `config`, then remote migrations, then deploy with the merged config |
| `npm run upload:instance` | `config`, then `wrangler versions upload` (no deploy, no migrations) |
| `npm run size` | Dry-run bundle into `.build/` |

Then create the first account and make it admin: [worker/README.md](worker/README.md#create-the-first-account).
Continuous deployment with Workers Builds, and the free-tier limits to watch, are also in
[worker/README.md](worker/README.md).

Back up the database:

```bash
npx wrangler d1 export DB --remote --output opengym.sql
```

## Tests

```bash
npm test                     # Worker units and the config merge (node:test)
npm run test:smoke           # integration test against `npm run dev`; setup in worker/README.md
cd frontend && npm test      # training logic (vitest)
cd mcp && npm test           # MCP server (vitest)
```

## Contributing

Changes to the app itself belong upstream on GitLab. Changes to the Cloudflare port belong here.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

openGym is Copyright (C) 2026 Duarte Santos and licensed AGPL-3.0-or-later ([LICENSE](LICENSE)); this fork's
changes are under the same licence. The exercise metadata and instructions are MIT via
[hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset). The exercise
images and animations are third-party content under neither licence and are not redistributed
here. See [NOTICE.md](NOTICE.md).
