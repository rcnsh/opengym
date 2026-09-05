# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

openGym is a self-hosted gym & body-weight tracker PWA. In this fork it is one Cloudflare Worker
serving both the built frontend and `/api/*` from a single origin, over a D1 database the user
owns — no third-party account, no telemetry. Passkey (WebAuthn) login, installable as a
home-screen app, optional Capacitor shells for standalone Android/iOS builds.
License: AGPL-3.0-or-later.

## Project layout

```
wrangler.jsonc  GENERIC Worker config — bindings, cron, compatibility date, nothing instance-
                specific. Lives at the root because a Deploy to Cloudflare button aimed at a
                subdirectory makes that subdirectory the whole repo (no frontend/ to build).
instance.jsonc  THIS deployment: route, D1 database_id, RP_ID/ORIGIN, policy vars.
                `npm run deploy:instance` deep-merges it over wrangler.jsonc into the gitignored
                wrangler.instance.json and deploys that. `npm run deploy` ignores it.
package.json    the Worker's manifest: its two runtime deps, wrangler, and every deploy script.
                There is no worker/package.json — wrangler runs from the root.
worker/    THE DEPLOYMENT. src/ is the Worker: same route table as api/server.js behind a
           (req, res) shim, D1 for storage, a Durable Object alarm for the rest timer, a Cron
           Trigger for day reminders. src/store.js is the D1 layer; src/push-messages.js and
           src/verify-error.js came from api/ and are live code. migrations/ is the D1 schema
           (`wrangler d1 migrations apply DB`). test/ has the node:test units and smoke.mjs.
           See worker/README.md.
frontend/  React 19 + Vite app (src/views, src/components, src/store, src/lib). Builds to static
           files the Worker serves. android/ + ios/ are the Capacitor shells (docs/MOBILE.md).
api/       REFERENCE ONLY — not deployed, not runnable, and now genuinely 100% dead. server.js
           is the upstream Node implementation the Worker was ported from; keep it to diff
           against when pulling upstream releases. Its two local imports dangle on purpose —
           they moved to worker/src/. See api/README.md.
mcp/       optional MCP server — read-only stdio bridge exposing a user's workouts/1RM/muscle
           balance to LLM clients (Claude Desktop, Cursor…). Two backends: ./data files, or
           HTTPS against a Cloudflare instance with a pairing token. Imports frontend/src/lib.
scripts/   generators for the committed exercise-name and instruction data (rarely run), plus
           wrangler-instance.mjs — the config merge, which has tests beside it.
docs/      CONFIG.md (every var and secret), API.md, DATA_IMPORTS.md, MOBILE.md.
```

**This fork removed the Docker Compose stack.** `docker-compose.yml`, `web/`, the Dockerfiles,
`website/`, `.gitlab-ci.yml`, `.gitea/` and `.gitlab/` are all deleted — Cloudflare is the only
target. A change to `api/server.js` does NOT reach the Worker; the handlers were ported, not
shared, so API and training-logic changes need applying in both places.

## Commands

```bash
# The Worker, locally (miniflare + local D1). Secrets go in .dev.vars at the repo root.
npm install && npx wrangler d1 migrations apply DB --local && npm run dev
npm test                    # node:test — push copy, verify-error, the config merge
npm run test:smoke          # integration test; needs `npm run dev` running, and INVITE_ONLY=1
npm run config              # write wrangler.instance.json without deploying
npm run deploy:instance     # merge + migrate + deploy; Workers Builds runs this on main

# Frontend dev server (hot reload), proxies /api to :3000
cd frontend && npm install && npm run dev

# Frontend tests (training logic: progression, 1RM, session read-back)
cd frontend && npm test            # vitest run
cd frontend && npm run test:watch
npx vitest run src/lib/progression.test.js   # single file
npx vitest run -t "some test name"           # single test by name

# MCP server tests
cd mcp && npm test

# Production build
cd frontend && npm run build
cd frontend && npm run build:mobile   # + cap sync, points media at the CDN dataset
```

There is no linter/formatter configured (no ESLint/Prettier config in the repo) and no
TypeScript — match the existing style by hand.

Upstream's CI gate is `.gitlab-ci.yml` on GitLab, its canonical remote (see README): it runs the
`frontend/` tests on Node 22 — the same version as `web/Dockerfile` / `api/Dockerfile`
(`node:22-alpine`) — and additionally builds and publishes the Docker images, packages the
signed Android APK, and deploys the demo/docs site.

**This fork's remote is GitHub (`rcnsh/opengym`), and its workflows do run** — upstream's note
that they are dormant mirrors was true only of upstream's own suspended GitHub account. On this
fork:

- `.github/workflows/test.yml` runs the `frontend/` suite on every push and PR. This is the gate.
- `.github/workflows/pages.yml` and `docker-publish.yml` have had their `push` triggers removed
  (see the FORK comments in each). The first publishes upstream's public demo and cannot succeed
  here; the second was pushing images to GHCR that nothing consumes. Both are still runnable by
  hand.
- `.gitea/workflows/` really is dormant — no Gitea remote is configured.

The Cloudflare deployment is continuous, via Cloudflare Workers Builds (not GitHub Actions).
Two triggers, both connected to `rcnsh/opengym` through a GitHub App, so there is no Cloudflare
API token in the repo:

| Trigger | Branches | Deploy command |
| --- | --- | --- |
| production | `main` | `npm run deploy:instance` |
| non-production | everything else | `npm run upload:instance` (uploads a version, does not deploy) |

Both use root directory *(repository root)* and build command `npm run build`. The root directory
was `worker` until the config moved up; a trigger still pointing there picks up the generic
`wrangler.jsonc` and fails on its placeholder `database_id` rather than deploying it. Note the
Builds API is not writable with the usual read tokens — these settings are dashboard-only.

The `Worker` Actions workflow runs alongside this rather than gating it — a commit that fails the
smoke test still deploys.

## Architecture

### Frontend (`frontend/src`)

- **`store/useStore.js`** — single Zustand store holding the entire client-side app state (`S`),
  persisted to `localStorage` (`gym_state_v1`) and debounce-pushed to the server when signed in
  (`pushState`, see `lib/api.js`). On the Capacitor mobile build it's also mirrored to a file via
  `lib/mobile.js` (`nativeSave`), since WebView storage can be evicted. `store/useUI.js` holds
  ephemeral UI state (modals, active sheet, etc.) separately from persisted data.
- **`lib/`** — pure, framework-free helpers, each paired with a same-directory `*.test.js`. This
  is where the domain logic lives, most importantly:
  - `progression.js` — the progression-rule engine (linear, Greyskull LP, double progression,
    time-based). Rules implement a shared policy interface; adding a new one plugs in here.
  - `onerm.js` — estimated 1RM from logged sets.
  - `finish-workout.js` — reduces a completed session back into state (weights advance, PRs, etc).
  - `recovery.js` / `recovery-view.js` — fatigue/muscle-recovery model.
  - `workout-model.js`, `supersetFlow.js` — in-session workout state machine, incl. supersets.
  - `exercises.js` / `exercises-data.js` — the exercise library (1,324 built-ins + user-defined).
  - `api.js` — the only place that talks to the backend (`fetch` wrapper, session cookie flows).
  - CONTRIBUTING.md is explicit: **anything that decides what you lift next, or reads a logged
    session back, is a pure helper here with a unit test beside it** — not verifiable by
    clicking, and the progression engine has already had two bugs that only a test caught.
- **`views/`** — one file per screen (Home, Workout, Plan, Library, Stats, History, Settings,
  Admin, Login, RoutineEdit), routed by `react-router-dom` from `App.jsx`.
- **`components/`** — shared UI (charts, modals, timers); `instr/` holds per-language exercise
  instruction text; `locales/` is the i18n string catalogue (`lib/i18n.js` / `i18n-core.js`).
- Mobile: `@capacitor/*` wraps the same web build into native shells under `frontend/android` and
  `frontend/ios` (see `docs/MOBILE.md`); `mobile.js` in `lib/` gates native-only behavior (file
  persistence, local notifications, wake lock) behind a `MOBILE` flag.

### API (`worker/src/index.js`, ported from `api/server.js`)

The reference implementation is a single file, no framework, plain `node:http`. Requests are dispatched through a `routes` object
keyed by `'METHOD /path'` (e.g. `routes['GET /api/health']`) matched against `req.method + ' ' +
url.pathname` — add a new endpoint by adding a key here. State is two flat JSON files under
`DATA_DIR` (`db.json`: users/credentials/subscriptions/invites; `state-<uid>.json`: per-user
workout data), written with a write-temp-then-rename atomic pattern (`atomicWrite`). Auth is
WebAuthn passkeys (`@simplewebauthn/server`) plus a signed session cookie (HMAC'd with a
`DATA_DIR/secret` generated on first boot) — no JWT/session-store dependency. Optional pieces
gated by env vars: `ADMIN_UIDS` (admin dashboard), `INVITE_ONLY` (signup needs a code),
`ALLOW_GUEST` (client-only guest mode never hits the server at all), plus a rotating
`data/audit.log` (JSONL) for sign-in/admin events. Web Push (`web-push`, VAPID keys
auto-generated into `data/vapid.json`) drives rest-timer-over and day-reminder notifications.

### MCP server (`mcp/src`)

Read-only stdio MCP bridge (`@modelcontextprotocol/sdk`) that lets an LLM client read a single
user's routines/workouts/body-weight/1RM/muscle-balance directly from the same `DATA_DIR` the API
writes to — no network call, no extra container. `state.js` loads/derives the data, `tools.js`
defines the exposed MCP tools (zod-validated schemas), `labels.js` maps internal keys to
human-readable labels, `index.js` wires it together. See `mcp/README.md` for the client-config
side (Claude Desktop / Cursor).

### Passkeys and self-hosting constraints

WebAuthn passkeys are bound to an exact hostname (`RP_ID`) and require HTTPS (localhost excepted)
— this shapes a lot of the API and Settings code (`RP_ID`/`ORIGIN` env vars, guest-mode fallback
when neither is available). Read `docs/CONFIG.md` before touching auth, session, or notification
code; it documents the exact contract (`RP_ID`, `ORIGIN`, `SESSION_DAYS`, `ADMIN_UIDS`,
`INVITE_ONLY`, `ALLOW_GUEST`, `AUDIT_*`, `VAPID_SUBJECT`) that real deployments depend on, and
which of those are vars and which are secrets. Upstream's `docs/SELF_HOSTING.md` was dropped with
the Docker stack; the port/proxy variables it documented (`PORT`, `WEB_PORT`, `NGINX_PORT`,
`BACKEND`) have no meaning here.

### Deploy

One Worker serves the built frontend (Workers static assets) and `/api/*` — single origin, which
is what passkeys require and what nginx used to provide. Storage is D1: `users`, `creds`, `subs`,
`invites`, `state_chunks` (the per-user blob, 64 KB per row), `challenges`, `pairings`,
`presence`, `audit`. `SESSION_SECRET`, the VAPID pair and `ADMIN_UIDS` are Worker secrets, not
vars — Cloudflare stores them write-only, so they cannot be read back.

Pushing to `main` builds and deploys via Workers Builds. The frontend must be
built first (`npm run build`, which points media at jsDelivr); the build command does that, and the
deploy command is `npm run deploy:instance` so `instance.jsonc` is folded back in — plain
`npx wrangler deploy` would ship the generic config with `RP_ID=localhost` and a placeholder
database id. `worker/README.md` has the whole contract, including the free-tier row limits worth
watching. Every variable and secret is in `docs/CONFIG.md`.

## Guidelines from CONTRIBUTING.md worth knowing before changing code

- **Dependency-light is a hard constraint, not a preference.** Frontend: React + Router + Zustand
  and nothing else. `api/`: two dependencies total. New dependencies are a hard sell either side.
- Don't commit `media/` or `data/` (gitignored).
- Training-logic changes (progression, 1RM, session read-back) need a unit test in `src/lib`
  beside the code, not just manual clicking-through.
