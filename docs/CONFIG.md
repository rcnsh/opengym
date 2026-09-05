# Configuration

Everything openGym reads at runtime, and where each piece belongs.

There are three places, and the difference between them matters:

| | File | In git | Changed by |
| --- | --- | --- | --- |
| **Generic config** | [`wrangler.jsonc`](../wrangler.jsonc) | yes | anyone forking openGym |
| **This deployment** | [`instance.jsonc`](../instance.jsonc) | yes | the operator of one instance |
| **Secrets** | none — `wrangler secret put` | **no** | the operator, once |

`wrangler.jsonc` holds nothing specific to any one deployment. That is deliberate: Cloudflare
reads it when someone clicks the **Deploy to Cloudflare** button, to work out which resources to
provision, and a hostname or database id belonging to somebody else would make the button
useless. It is also why it sits at the repository root rather than in `worker/` — a Deploy button
aimed at a subdirectory turns that subdirectory into the entire new repository, and `worker/`
alone has no `frontend/` to build.

`instance.jsonc` is where one deployment's own answers live: its hostname, its database, its
policy choices. **If you forked this repo, this is the file you edit.**

```bash
npm run deploy            # deploys wrangler.jsonc as it stands, ignoring instance.jsonc
npm run deploy:instance   # merges instance.jsonc over it, then deploys the result
```

The merge is a deep merge — objects combine key by key, arrays and scalars replace outright — and
writes `wrangler.instance.json`, which is gitignored and regenerated every time. It is covered by
`npm test`, because a bug there would not throw: it would quietly deploy a working Worker pointed
at the wrong instance.

**If you arrived through the Deploy to Cloudflare button**, your clone came with this repo's
`instance.jsonc` — naming a hostname and a database that are not yours. Nothing goes wrong: the
button configures `npm run deploy`, which never reads that file. You have two ways to settle it:

1. **Ignore `instance.jsonc`** and put your `RP_ID`, `ORIGIN` and any other settings straight into
   `wrangler.jsonc`'s `vars`. Simplest, and the button's own flow.
2. **Use it**, by replacing its values with yours and changing your Worker's deploy command
   (Settings → Builds) to `npm run deploy:instance`. Worth it if you expect to pull changes from
   this repo later, since it keeps your settings out of the file that will conflict.

---

## Variables

None of these are secret; all are visible to anyone who reads the repo. Every one has a working
default in [`worker/src/runtime.js`](../worker/src/runtime.js), so a var you leave out is a var
you have accepted the default for.

| Variable | What it is | Default |
| --- | --- | --- |
| `RP_ID` | Bare hostname passkeys are bound to — **changing it invalidates every passkey** | `localhost` |
| `ORIGIN` | Full URL the app is served from, no trailing slash | `http://localhost:8787` |
| `RP_NAME` | Name shown in the passkey prompt | `openGym` |
| `SESSION_DAYS` | How long a sign-in lasts, in days | `90` |
| `INVITE_ONLY` | Require an invite code to create a profile | off |
| `ALLOW_GUEST` | Offer "Continue without account" — `0` to require a profile | on |
| `AUDIT_LOG` | Record sign-ins and admin actions — `0` to record nothing | on |
| `AUDIT_MAX` | Events kept in the activity log; `0` for no limit | `5000` |
| `AUDIT_DAYS` | Days kept in the activity log; `0` to keep until `AUDIT_MAX` | `90` |
| `AUDIT_IP` | Record the caller's address: `off`, `net` (network only) or `full` | `net` |
| `VAPID_SUBJECT` | Contact URL sent with push notifications | your `ORIGIN` |

`RP_ID`, `ORIGIN` and the hostname you actually serve from must all agree. If they do not, every
passkey ceremony fails with an origin mismatch — the single most common self-hosting failure.

The port and proxy variables the old Docker stack needed (`PORT`, `WEB_PORT`, `NGINX_PORT`,
`BACKEND`) have no meaning here. One Worker serves both halves, so there is nothing to proxy.

## Secrets

Four values never appear in any file in this repository. Set each once:

```bash
npx wrangler secret put SESSION_SECRET
```

| Secret | What it is | If you lose it |
| --- | --- | --- |
| `SESSION_SECRET` | Signs session cookies (`openssl rand -hex 32`) | everyone is signed out |
| `VAPID_PUBLIC_KEY` | Web Push key pair, generated with | every push subscription dies |
| `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` | — |
| `ADMIN_UIDS` | Comma-separated uids with the admin dashboard | nobody can administer the instance |

Upstream generates the first three into `./data` on first boot. There is no filesystem here, so
they are created up front — and **Cloudflare stores secrets write-only and cannot show them to
you again**, so keep a copy off the machine that made them.

`ADMIN_UIDS` is a secret rather than a var only because this repository is public: a uid is
useless without the matching passkey, but naming the admin account tells a reader which one to go
after. It is read per request, so setting it needs no redeploy.

For local development the same four go in `.dev.vars` (gitignored) — copy
[`.dev.vars.example`](../.dev.vars.example) and fill it in. Set `RP_ID=localhost` and
`ORIGIN=http://localhost:8787` there too; passkeys work over plain HTTP on localhost and nowhere
else.

## Build-time values

Two things are baked into the frontend bundle rather than read at runtime, so setting them in
`vars` does nothing:

- `VITE_IMG_BASE` / `VITE_GIF_BASE` — where the ~140 MB of exercise images and animations are
  fetched from. `npm run build` (via `frontend`'s `build:cloudflare`) points them at jsDelivr,
  pinned to a commit, so no media is hosted or committed here.
- `VITE_MOBILE` — set only by `build:mobile`, which gates the Capacitor-only behaviour
  (file persistence, local notifications, wake lock). See [MOBILE.md](MOBILE.md).
