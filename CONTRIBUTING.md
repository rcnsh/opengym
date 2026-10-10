# Contributing to openGym

Thanks for taking a look! openGym is intentionally small and dependency-light, and the goal is
to keep it that way — easy to read, easy to self-host.

## Where changes go

This repository is a Cloudflare port of [upstream openGym](https://gitlab.com/DuarteSantos8/opengym).

| Change | Send it to |
| --- | --- |
| The app itself: frontend, training logic in `frontend/src/lib`, exercise data, translations, `api/server.js`, `mcp/` file backend | [Upstream on GitLab](https://gitlab.com/DuarteSantos8/opengym/-/merge_requests); this fork pulls upstream releases |
| The Cloudflare port: `worker/`, `wrangler.jsonc`, `instance.jsonc`, `scripts/wrangler-instance.mjs`, the `mcp/` remote (`OPENGYM_URL`) backend, deployment docs | [A pull request here](https://github.com/rcnsh/opengym/pulls) |
| A bug that only happens on the Worker deployment | [An issue here](https://github.com/rcnsh/opengym/issues) |

If an upstream API change needs porting, the handler in `worker/src/index.js` is changed here by
hand; see [ARCHITECTURE.md](ARCHITECTURE.md#keeping-in-step-with-upstream).

## Project layout

```
wrangler.jsonc  the generic Worker config — bindings, cron, compatibility date. Deployable by
                anyone, which is what makes the README's Deploy to Cloudflare button work.
instance.jsonc  ONE deployment's own values: hostname, database id, policy choices. If you fork
                openGym, this is the file you edit. See docs/CONFIG.md.
worker/    THE DEPLOYMENT. src/ is the Cloudflare Worker: the same route table as
           api/server.js behind a (req, res) shim, D1 in place of the JSON files, a Durable
           Object alarm for the rest timer and a Cron Trigger for day reminders.
           migrations/ is the D1 schema; test/ holds the unit tests and the smoke test.
           See worker/README.md.
frontend/  React + Vite app (src/views, src/components, src/store, src/lib). Builds to static
           files the Worker serves. android/ + ios/ are the Capacitor shells for the standalone
           mobile app (docs/MOBILE.md).
mcp/       optional Model Context Protocol server — read-only stdio bridge for LLM apps
           (Claude Desktop, Cursor, …) to query a user's workouts/1RM/muscle balance. Not part
           of the deployment; only runs when an LLM client spawns it. See mcp/README.md.
api/       REFERENCE ONLY, not deployed and not runnable — upstream's Node implementation, kept
           to diff against when pulling an upstream release. See api/README.md.
scripts/   generators for the committed exercise data, plus the config merge used by deploys.
docs/      CONFIG, API, DATA_IMPORTS, MOBILE.
media/     exercise img/gif (gitignored; the deployed build points at jsDelivr instead).
```

**This fork removed the Docker Compose stack** — `docker-compose.yml`, `web/` and the Dockerfiles
are gone, and Cloudflare Workers is the only deployment target. A change to `api/server.js` does
**not** reach the Worker: the handlers were ported, not shared, so API and training-logic changes
need applying in both places if you want the upstream diff to stay readable. The Worker has its
own tests (`npm test` and `npm run test:smoke`) and its own CI workflow.

## Running for development

```bash
# the Worker, locally (miniflare + a local D1). Secrets go in .dev.vars — copy .dev.vars.example.
npm install
npm run build                     # the Worker serves frontend/dist, so it must exist
npx wrangler d1 migrations apply DB --local
npm run dev                       # http://localhost:8787

# frontend hot reload, with /api proxied to the dev Worker above:
cd frontend && npm install && API_TARGET=http://127.0.0.1:8787 npm run dev
# training logic (progression rules, 1RM, how a session is read back):
cd frontend && npm test
```

Passkey verification checks the page origin against `ORIGIN`. To sign in through the Vite dev
server rather than on :8787, set `ORIGIN` in `.dev.vars` to the Vite URL (default
`http://localhost:5173`).

Tests, matching CI (`.github/workflows/test.yml` and `worker.yml`):

```bash
npm test                                   # Worker units + config merge
npm run test:smoke                         # needs `npm run dev`; setup in worker/README.md
cd frontend && npm test && npm run build
cd frontend && node scripts/check-locales.mjs && node scripts/check-source-strings.mjs
cd frontend && npm run test:fatigue-probe
cd mcp && npm test && npm run check:node-loadable
```

## Guidelines

- **Keep it dependency-light.** The frontend uses React + Router + Zustand and nothing else;
  new deps (front or back) are a hard sell. The Worker has two (`@simplewebauthn/server` for
  passkeys, `web-push` for notifications) — keep it near that.
- **Match the style.** Small components, clear names, comments only where the "why" isn't obvious.
  State lives in the Zustand store (`src/store`); pure helpers in `src/lib`.
- **Don't commit** the exercise media (`media/`) or `data/` — they're gitignored.
- **Test the flow** you touched — click through the affected screens (and the workout flow) in a
  browser before opening a merge request.
- **Training logic gets a unit test.** Anything deciding what you lift next, or reading a logged
  session back, belongs in a pure helper in `src/lib` with tests beside it (`npm test`). These
  rules are easy to get subtly wrong and nearly impossible to verify by clicking — the
  progression engine grew two real bugs that only a test pinned down.

## Good first issues

- Additional starter plans (upper/lower, full-body, 5×5…)
- More languages for the exercise instructions (the dataset ships several)
- Percentage / training-max programming (5/3/1-style) on top of the progression engine in
  `src/lib/progression.js` — the policy interface is already there
- Accessibility passes on the workout and chart screens

## Where to ask what

| You have | Goes to |
| --- | --- |
| A quick question, or you'd rather just chat | [The Discord](https://discord.gg/e62jY6fwVb) |
| A question, or self-hosting that won't behave | [An issue labelled `question`](https://gitlab.com/DuarteSantos8/opengym/-/issues) |
| An idea you're not sure about yet | [An issue labelled `idea`](https://gitlab.com/DuarteSantos8/opengym/-/issues) |
| A reproducible bug | [Issues](https://gitlab.com/DuarteSantos8/opengym/-/issues) |
| A change you've already built | A merge request |
| Anything specific to the Cloudflare deployment | [This fork's issues](https://github.com/rcnsh/opengym/issues) |

The rows above that point at GitLab are upstream's channels, for the app itself. Problems with the
Worker, D1, Wrangler config or deploys are this fork's, not upstream's.

GitLab has no Discussions, so questions and ideas are issues too — just labelled, so nobody
mistakes a question for agreed-on work. An answered question is worth more than the same answer
in a chat log: the next person searching "passkey login fails behind my reverse proxy" finds it.
That is the one thing the Discord can't do, so if an answer there turns out to be worth keeping,
it belongs in an issue afterwards.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and your browser/OS. If it's
about login/passkeys, include your `RP_ID`/`ORIGIN` (not the `data/` contents) — most login
issues are an origin mismatch.

By contributing you agree your work is licensed under the project's [GNU AGPL v3.0](LICENSE).
