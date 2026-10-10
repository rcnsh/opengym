# Architecture

How this fork runs [upstream openGym](https://gitlab.com/DuarteSantos8/opengym) on Cloudflare.
The frontend and the training logic are upstream's; what changed is the server underneath.

## Request flow

```
browser / PWA ──HTTPS──▶ Worker "opengym"
                          ├─ /api/*  → worker/src/index.js  (run_worker_first)
                          └─ /*      → ASSETS: frontend/dist/  (SPA fallback)
                                 │
                 ┌───────────────┼──────────────────┐
                 ▼               ▼                  ▼
              D1 "DB"     REST_TIMER (DO)     Cron * * * * *
```

One Worker serves the built frontend and the API from one origin. WebAuthn needs that; upstream
used nginx for it.

## What replaced upstream's server pieces

| Upstream (`api/server.js`, Docker) | Here |
| --- | --- |
| `http.createServer` | `export default { fetch, scheduled }` in `worker/src/index.js` |
| Handlers on node's `(req, res)` | Same handlers, run through a fake `req`/`res` shim (`makeRes`) so the route table diffs line-for-line against upstream |
| nginx + static build | Workers static assets, `not_found_handling: single-page-application` |
| `db.json` (users, creds, subs, invites) | D1 tables `users`, `creds`, `subs`, `invites` |
| `state-<uid>.json` | D1 `state_chunks`, 64 KB per row (`CHUNK` in `worker/src/store.js`) |
| `data/audit.log` | D1 `audit` |
| In-memory `challenges` / `pairings` Maps | D1 rows with `exp`, swept on read and by the cron |
| In-memory `presence` Map | D1 `presence` |
| `data/secret`, `data/vapid.json` | Worker secrets |
| `setTimeout` rest timer | `RestTimer` Durable Object alarm, one object per user |
| 10 s reminder `setInterval` | Cron Trigger every minute |
| `web-push` `sendNotification` | `web-push` `generateRequestDetails` + `fetch` |
| Local `media/` volume | jsDelivr URLs baked in at build time |

Session signing uses `node:crypto` unchanged, via the Node compatibility the compatibility date
enables.

## Bindings

Defined in `wrangler.jsonc`:

| Binding | Kind | Code |
| --- | --- | --- |
| `DB` | D1, migrations in `worker/migrations/` | `worker/src/store.js` |
| `REST_TIMER` | Durable Object class `RestTimer` (SQLite-backed, migration tag `v1`) | `worker/src/user-do.js` |
| `ASSETS` | Static assets, `./frontend/dist/` | fallback in `fetch` |
| cron `* * * * *` | Trigger | `scheduled` in `worker/src/index.js` |

Variables and secrets: [README.md](README.md#configuration) and [docs/CONFIG.md](docs/CONFIG.md).

## Storage

Schema: `worker/migrations/0001_initial_schema.sql`. Tables: `users`, `creds`, `subs`, `invites`,
`state_chunks`, `challenges`, `pairings`, `presence`, `audit`. All `CREATE TABLE IF NOT EXISTS`.

Each user's app state is one JSON document, as upstream. `PUT /api/data` splits it into 64 KB rows
in `state_chunks` to stay under D1's statement and row size limits. `worker/src/store.js` returns
the same object shapes upstream's handlers expect, so the handlers did not change.

The Durable Object stores only the pending rest-timer job and its alarm. Everything else is in D1.

## Config layering

```
wrangler.jsonc   generic: bindings, cron, placeholder database_id, localhost vars
instance.jsonc   one deployment: name, routes, database_id, RP_ID/ORIGIN, policy vars
       │
       └─ scripts/wrangler-instance.mjs (npm run config)
              deep merge → wrangler.instance.json (gitignored) → wrangler deploy -c
```

`wrangler.jsonc` stays generic so the Deploy to Cloudflare button works for anyone. It sits at the
repository root because the button treats a subdirectory as the whole repository, which would
leave no `frontend/` to build.

## Key files

| Path | Role |
| --- | --- |
| `worker/src/index.js` | Route table, auth/CSRF checks, `(req, res)` shim, `fetch` and `scheduled` entry points |
| `worker/src/store.js` | D1 data layer |
| `worker/src/runtime.js` | Env-to-config (with defaults) and push sending; shared by the Worker and the DO |
| `worker/src/user-do.js` | `RestTimer` Durable Object |
| `worker/src/push-messages.js` | Push notification copy (from upstream) |
| `worker/src/verify-error.js` | Passkey verification error messages (from upstream) |
| `worker/migrations/` | D1 schema |
| `worker/test/` | `node:test` units and `smoke.mjs` integration test |
| `scripts/wrangler-instance.mjs` | Config merge, tested by `scripts/wrangler-instance.test.mjs` |
| `wrangler.jsonc`, `instance.jsonc` | Generic and per-instance config |
| `api/server.js` | Upstream reference, not deployed |
| `frontend/src/lib/api.js` | The frontend's only API client |
| `frontend/src/lib/` | Pure training logic (progression, 1RM, recovery), unchanged from upstream in role |
| `frontend/src/store/useStore.js` | Client state, persisted locally and synced to `/api/data` |
| `mcp/` | Optional read-only MCP server; remote backend reads a deployed instance over HTTPS |

## Keeping in step with upstream

`api/server.js` and `worker/src/index.js` share a route table but not code. An upstream change to
an API handler has to be ported by hand: diff the new upstream `api/server.js` against the copy
here, then apply the same change in `worker/src/`. Frontend changes merge normally.

## Deliberate differences

- Day reminders can be up to ~60 s late (cron granularity).
- No SSRF guard on push endpoints. A Worker has no private network to reach; only the URL shape is
  checked.
- `AUDIT_DAYS` defaults to `0` (no age limit) in `worker/src/runtime.js`; upstream defaults to 90.
- `instance.jsonc` sets `ALLOW_GUEST=0` and `INVITE_ONLY=1`. The code defaults match upstream
  (guest allowed, open signup).
