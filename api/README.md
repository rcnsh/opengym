# `api/` — upstream reference, not deployed

`server.js` is the Node implementation openGym's Cloudflare Worker was ported from. It is kept
here for one reason: **to diff against when pulling an upstream release.** The route table,
request and response shapes and audit events in `worker/src/index.js` track it line for line, so
a change upstream is readable as a change here.

Nothing in this directory runs. This fork removed the Docker Compose stack, so there is no
Dockerfile, no `web/` and no `./data` — see the top of the [README](../README.md).

`server.js` imports `./push-messages.js` and `./verify-error.js`, which are **no longer in this
directory**. They were the exception to "reference only" — the Worker imports both, so live code
was living in a folder documented as dead. They now sit beside the code that uses them, with
their tests:

| was | now |
| --- | --- |
| `api/push-messages.js` | [`worker/src/push-messages.js`](../worker/src/push-messages.js) |
| `api/verify-error.js` | [`worker/src/verify-error.js`](../worker/src/verify-error.js) |
| `api/*.test.js` | [`worker/test/`](../worker/test/), run by `npm test` at the repo root |

So `server.js`'s two local imports dangle. That is deliberate and harmless — it cannot be started
here anyway — and it keeps the diff against upstream honest everywhere else in the file.

`openapi.yaml` still describes the live HTTP API accurately; the Worker did not change the
contract. It is rendered in [docs/API.md](../docs/API.md).
