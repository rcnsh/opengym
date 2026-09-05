> ### This is a modified fork
>
> Changed since 2026-09 to add a **[Cloudflare Workers deployment target](worker/README.md)** —
> the same app on Cloudflare's free tier instead of a VPS: no server to run, no Docker, no
> monthly cost. One Worker serves the frontend and the API from a single origin, with D1 in
> place of the JSON files, a Durable Object alarm for the rest timer and a Cron Trigger for
> day reminders.
>
> **You need a domain you control** — passkeys are bound to the hostname, and `*.workers.dev`
> will not do. See [worker/README.md](worker/README.md) for why, and for the ~15 minute setup.
>
> **The Docker Compose stack has been removed from this fork.** `docker-compose.yml`, `web/` and
> the Dockerfiles are gone; Cloudflare is the only deployment target here. `api/server.js` is
> kept only as the reference the Worker was ported from — see [api/README.md](api/README.md).
> If you want the original self-hosted stack, use upstream.
>
> Upstream is [openGym by Duarte Santos](https://gitlab.com/DuarteSantos8/opengym).
> Licensed AGPL-3.0-or-later, like upstream — see [LICENSE](LICENSE).

<div align="center">

<img src="assets/banner.png" alt="openGym" width="720">

<br>

**A self-hosted gym & body-weight tracker you actually own.**

Plan your week, run guided workouts, track every set and your body weight over time —
on your phone, synced across devices, behind your own passkey login.
No account on someone else's server, no subscription, no ads. Runs free on Cloudflare Workers.

<br>

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-a3e635?style=flat-square)](LICENSE)
![Self-hosted](https://img.shields.io/badge/self--hosted-%F0%9F%8F%A0-60a5fa?style=flat-square)
![PWA](https://img.shields.io/badge/PWA-installable-a78bfa?style=flat-square)
![React](https://img.shields.io/badge/React-19-38bdf8?style=flat-square&logo=react&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![No tracking](https://img.shields.io/badge/telemetry-none-f472b6?style=flat-square)
<br>
[![Worker CI](https://github.com/rcnsh/opengym/actions/workflows/worker.yml/badge.svg)](https://github.com/rcnsh/opengym/actions/workflows/worker.yml)
[![Tests](https://github.com/rcnsh/opengym/actions/workflows/test.yml/badge.svg)](https://github.com/rcnsh/opengym/actions/workflows/test.yml)

<br>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rcnsh/opengym)

<sub>Forks the repo to your account, provisions the D1 database and deploys it — then read
<a href="#quick-start-self-host">Quick start</a>, because <b>passkeys will not work until you point
<code>RP_ID</code> at a hostname you own</b>.</sub>

</div>

<br>

<div align="center">
<table>
<tr>
<td align="center"><img src="assets/screenshots/home.png" alt="Home" width="230"><br><sub><b>Home</b> — today's workout & weight</sub></td>
<td align="center"><img src="assets/screenshots/workout.png" alt="Workout" width="230"><br><sub><b>Guided workout</b> — animated demos & sets</sub></td>
<td align="center"><img src="assets/screenshots/stats.png" alt="Stats" width="230"><br><sub><b>Stats</b> — heatmap, charts & PRs</sub></td>
</tr>
</table>
</div>

<div align="center">

### Upstream: [🌐 opengym.duarte-santos.ch](https://opengym.duarte-santos.ch) · [📦 GitLab](https://gitlab.com/DuarteSantos8/opengym)

<sub>That site, its demo and its APK downloads belong to the original project, not to this fork —
they run upstream's code, not the version here. Deploy guide for <b>this</b> fork:
<a href="worker/README.md">worker/README.md</a>.</sub>

</div>

## Why

Most workout apps lock your data behind a login on their servers, nag you to upgrade, or
disappear when the startup does. openGym is the opposite: **it runs on your box, your data
stays in a folder you control, and it's yours to fork.** It still feels modern — installable
as a home-screen app, passkey sign-in, offline support, sync across your phone and laptop.

## Features

- ⚖️ **Body-weight tracking** — interactive chart with a goal line you set, gains/losses colored by whether they move toward it
- 🏋️ **Weekly plan** — a routine per weekday, over a library of **1,324 exercises** (searchable, with animated demos)
- 🗓️ **Reschedule any day** — sick, missed a session, or fewer gym days this week? Move a workout to another day without touching your weekly plan
- 📅 **Your week starts where you say** — Monday or Sunday, in Settings. The weekly plan, the day strip on Home, the calendar and every "this week" total follow it, so the app reads the way the calendar on your wall does
- ▶️ **Guided workouts** — it knows what day it is and starts today's session; asks your body weight first, pre-fills your weights from last time, rest timer, PR detection, per-exercise weight tracking. On a rest day it doesn't just say "rest day" — it names when your next session is and what it is
- 🙈 **Animations are your call** — the exercise demos can be full size, small, or hidden entirely during a workout. Hidden collapses the media rather than leaving a gap, for anyone who finds a looping GIF between sets more distracting than useful
- ☀️ **The screen stays awake while you train** — no unlocking the phone and finding your place again between every set. On for as long as a workout is running, released the moment you finish it, and switchable off in Settings
- 🔗 **Supersets** — plan them into a routine or pair two exercises *mid-session* with “make superset with previous/next”, then work through the group back-to-back with a single rest at the end of each round. Unpair at any time; a group of one dissolves itself
- 🔥 **Warm-up sets** — mark the ramp-up rows as warm-ups and they stay out of the numbers that should not see them: no effect on your estimated 1RM, your progression, or the fatigue map, while still being there in the session where you need them. A weight change cascades down the rows that share their phase, not across the divide
- ➖ **Change your mind mid-session** — add an exercise you decided to do, or remove one you didn't, without ending the workout. Removing a member of a superset asks which one
- ⏱️ **Timed exercises** — planks, hangs, wall sits and loaded carries are logged by time, not reps, with a work timer that counts the set itself (separate from the rest timer) and logs the time you actually held. They can carry weight too
- ⏲️ **Rest per exercise** — heavy triples and curls don't want the same break: give any exercise its own rest time and it overrides the global timer for that exercise (a superset rests once, taking the longest). Travels with shared plans
- 🧘 **Planned deloads** — flag a routine as excluded from automatic progression: its sessions open with the routine's own target weights, stay in your history and statistics, and never become the baseline your next regular session progresses from
- 📈 **Progression that follows a rule** — pick one per routine, override it per exercise: linear, **Greyskull LP** (AMRAP top set, double jumps, 10 % resets), double progression through a **visible rep range** (both bounds editable, per-side exercises step in twos), or adding time. Your weights are already right when the session opens, and every target says *why* it's that number. Missed reps never advance the load, stalls trigger a deload, and bodyweight exercises progress in reps instead
- 💪 **Estimated 1RM** — per exercise, from your best eligible set (it names which one), with its own progress curve and a calculator for sets you haven't done. Won't guess above 12 reps
- 🎯 **Effort per set, in your scale** — an optional third column rating how hard a set was, as **RIR** (reps left in the tank) or **RPE** (the same judgement on a 10-point scale). Off by default; each set keeps the scale it was logged with, and nothing else reads the value — your progression and 1RM are unaffected
- 💪 **Bodyweight exercises, logged as bodyweight** — push-ups, pull-ups, dips and 300-odd others arrive knowing they carry no load, so there's no weight column and no working-weight prompt: one stepper, log the reps. Add a dip belt and it reads as an addition, and progression goes back to following the weight. Without one, reps climb — and past a ceiling you set, a set is added instead of a rep, up to the point where the honest advice is load or a harder variation
- ↔️ **Reps per side** — for lunges, single-arm rows and the rest. You log the total, the app shows the split ("8 per side"), and the target steps in twos so it never lands on a number one side can't have
- 🏋️ **Plate math for barbell work** — barbell, EZ, trap bar and Smith machine carry a bar weight (20 kg / 45 lb and friends, or your own per exercise), and the workout screen tells you what goes on each side: *Bar 20 kg · 30 kg per side*. You still log the total, so your history, progression and 1RM keep meaning exactly what they always did
- 📝 **Log a past workout** — forgot your phone, trained on paper, or switched apps? Add a session after the fact from History: date, start time, duration, routine or freestyle, then the normal workout screen — weights, reps, RIR/RPE, timed sets and all. If that day already has a workout you choose: replace it, keep both, or cancel. Backfilled sessions never claim PRs against workouts that came later
- 🎲 **Freestyle sessions** — train without a plan and pick exercises as you go. Each one arrives prefilled from the last time you did it — same sets, same reps and weight by position — so an unplanned session doesn't start by asking you to retype last week
- 🏃 **Cardio** — log time + speed, not just weight × reps
- 📤 **Share a plan** — send someone your routines and week schedule as a small file (no workouts, no weigh-ins), or print it as a clean PDF. Importing merges, so their plan is never overwritten
- 🔧 **Filter by equipment** — narrow the library to what you actually own; the options adapt to what you've picked, so every combination on screen has results behind it
- ✨ **Your own exercises** — a name and a body part is enough; they behave like built-in ones everywhere, with an optional description instead of an animation
- 🟩 **Activity heatmap** — a GitHub-style year view, shaded by time spent training
- 💪 **Muscle map, three ways** — a front-and-back body diagram you can read as **Balance** (where the volume went, over a week, a month or all time — naming the muscles you *haven't* trained), **Fatigue** (what is still recovering, weighted by how close each set was to your maximum, decaying smoothly rather than expiring at a window edge) or **Strength** (how long since you trained each muscle, and behind every one the exercises that built it with their estimated 1RM). It previews what a routine hits while you build it, and shows what you just trained when you finish. Male or female figure, your pick
- 📳 **See the timer end, not just hear it** — an opt-in screen flash when a rest or work timer finishes, for loud gyms and headphones
- 🔔 **Push notifications** — rest-timer alerts even with the app closed, plus an optional reminder on days you have a workout planned but haven't logged one — on the Android app scheduled per calendar date, so a day you already trained or rescheduled stays quiet. Opt in per profile; keys are generated on first run, nothing to configure
- 🔑 **Passkeys, not passwords** — Face ID / Touch ID / fingerprint login; each profile keeps its own data, synced across devices. Sign-ins last 90 days by default (configurable), and “sign out everywhere” in Settings ends every session on every device at once
- 🛠️ **Admin dashboard** (optional) — for whoever runs the instance: who's training right now, per-user history, disable accounts, invite-only signup, and an **activity log** of sign-ins, failed attempts and admin actions. Off by default, so a fresh instance stays open with no admin
- 🎨 **Designed, not assembled** — light/dark themes and 8 accent colors saved to your profile, over a hand-drawn icon set instead of emoji, so it looks the same on every phone
- 🌍 **14 languages** — full UI translation (EN, DE, ES, FR, IT, PT (Portugal), PT (Brazil), PL, TR, RU, ZH, KO, HI, TH, HU); exercise instructions localized in 12 of them and built-in exercise names shown bilingually in PT-BR and HU, all loaded on demand so the app stays fast
- 📥 **Bring your history with you** — import from **FitNotes** (Android and iOS), **Strong** and **Hevy** (CSV or directly with a [Hevy Pro API key](https://hevy.com/settings?developer)), or body weight straight out of an **Apple Health** export. Exercise names are matched against the library and anything unrecognised becomes one of your own exercises, so nothing in the file is dropped
- 📦 **Yours to keep** — one-tap JSON export/import, guest mode, **no telemetry**
- 🤖 **Ask an AI about your training** (optional) — an [MCP server](mcp/README.md) lets a client like Claude Desktop or Cursor read your history in your own words: *"what did I bench last week?"*. Read-only, spawned locally by the client, nothing leaves your box. Not in the Docker build — if you don't use an AI assistant, it isn't there
- 📱 **Standalone Android app** — the whole tracker as a sideloadable APK: no account, no server, data on the phone, native workout reminders ([download](https://opengym.duarte-santos.ch))

## Quick start (self-host)

This fork deploys to **Cloudflare Workers** on the free tier — one Worker serving the app and
the API from a single origin, D1 for storage. No server to run, no Docker, no monthly cost.

You need a Cloudflare account and a domain on it. Passkeys are bound to the hostname, and
`*.workers.dev` will not do — see [worker/README.md](worker/README.md) for why.

**The quick way.** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rcnsh/opengym)
copies the repo to your GitHub account, creates the D1 database, prompts you for the secrets and
deploys, with every later push building automatically.

It cannot know your hostname, though, so it deploys with `RP_ID=localhost` and passkeys will not
work yet. Add your custom domain to the Worker, then set `RP_ID` and `ORIGIN` to it — in the
`vars` block of [`wrangler.jsonc`](wrangler.jsonc) in your new repo — and push. Do that **before
anyone signs up**: changing `RP_ID` later invalidates every passkey already registered. The
`instance.jsonc` you inherited is this instance's, and `npm run deploy` ignores it; see
[docs/CONFIG.md](docs/CONFIG.md) if you would rather keep your settings there instead.

**By hand**, if you would rather see each step:

```bash
git clone https://github.com/rcnsh/opengym && cd opengym && npm install
npx wrangler d1 create opengym              # put the printed id in instance.jsonc
$EDITOR instance.jsonc                      # your hostname, your database, your policy
npm run deploy:instance                     # merges it in, migrates, deploys
```

Either way, the full sequence — the values in [`instance.jsonc`](instance.jsonc) you must change,
the four secrets, and how to create the first account on an invite-only instance — is in
**[worker/README.md](worker/README.md)**. Budget fifteen minutes.

The exercise media (~140 MB of images and GIFs) is not downloaded or hosted: the Cloudflare
build points at jsDelivr instead, pinned to a commit.

> **About that media:** it reaches openGym through
> [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset), which
> redistributes [ExerciseDB v1](https://exercisedb.dev/) — its metadata and instruction text are
> MIT, but the images and animations are third-party content under *neither* that MIT license nor
> openGym's AGPL, and their ownership is currently disputed between Gym visual and ExerciseDB.
> openGym ships none of it: your instance downloads it from upstream. Reusing it yourself,
> commercially or not, means clearing it with the rights holder — see [NOTICE.md](NOTICE.md).
Cloudflare terminates HTTPS for you and creates the DNS record at deploy time, so there is no
certificate or reverse proxy to configure — which is what passkeys need and the only reason the
original stack wanted a domain and a tunnel.

## Mobile app (no server at all)

The same codebase also builds a **standalone mobile app** (Capacitor): no account, no sync,
no backend — everything stays on the phone, with native workout-day reminders and share-sheet
backups. Self-hosting gets you multi-device sync and profiles for friends & family; the
mobile app is the install-and-done flavor.

- **Android:** [**download the APK**](https://opengym.duarte-santos.ch) — or straight from
  [GitLab's package registry](https://gitlab.com/DuarteSantos8/opengym/-/packages), where every
  build sits next to its `.sha256` — and sideload it; openGym is deliberately not on the Play
  Store. Or build it yourself: **[docs/MOBILE.md](docs/MOBILE.md)**.
- **iPhone:** Apple doesn't allow installing apps outside the App Store, so there is no iOS
  download. Self-host and add it to your home screen from Safari (it's a full PWA), or build
  the native app onto your own device from Xcode — see **[docs/MOBILE.md](docs/MOBILE.md)**.

## How it works

One Worker is the whole backend. It serves the built frontend as static assets and answers
`/api/*` itself, so the app and its API share **one origin** — which is what passkeys require,
and what nginx was doing in the Docker stack this fork removed.

```
┌─────────────┐         ┌────────────────────────────────────────────┐
│  Your phone │──HTTPS──▶│  opengym  (one Cloudflare Worker)          │
│  / laptop   │         │   ├─ /api/*  → WebAuthn, sync, admin       │
└─────────────┘         │   └─ /*      → the built React app         │
                        └───────┬─────────────┬──────────────┬───────┘
                                ▼             ▼              ▼
                          ┌──────────┐  ┌───────────┐  ┌───────────┐
                          │ D1       │  │ Durable   │  │ Cron      │
                          │ profiles │  │ Object    │  │ Trigger   │
                          │ + state  │  │ rest timer│  │ reminders │
                          └──────────┘  └───────────┘  └───────────┘
```

| | |
| --- | --- |
| [`wrangler.jsonc`](wrangler.jsonc) | the generic config — what the Deploy button reads |
| [`instance.jsonc`](instance.jsonc) | **one deployment's own values**: hostname, database, policy |
| [`worker/src/`](worker/src) | the Worker: route table, D1 store, rest-timer Durable Object |
| [`worker/migrations/`](worker/migrations) | the D1 schema, applied by `npm run deploy` |
| [`frontend/`](frontend) | React 19 + Vite (React Router + Zustand); also the Capacitor mobile shells |
| [`mcp/`](mcp) | optional read-only MCP server, so an LLM client can read your training |
| [`api/`](api/README.md) | upstream's Node implementation, kept only to diff against. Not deployed |

Configuration — every variable, every secret, and which file it belongs in — is
**[docs/CONFIG.md](docs/CONFIG.md)**. The full HTTP API is an OpenAPI spec in
[`api/openapi.yaml`](api/openapi.yaml), rendered in [docs/API.md](docs/API.md).

## Your data

Lives in **your own D1 database**, on your own Cloudflare account: profiles and public passkeys,
each user's plan, workouts, body weight and settings, and the admin activity log (sign-ins and
admin actions, no IP addresses unless you ask for them). Nothing is shared with this repo's
author or with anyone else, and there is no telemetry to turn off.

**Back up that database and you've backed up everything** —
`npx wrangler d1 export DB --remote --output opengym.sql`. Passkey private keys never touch the
server at all; they stay in your phone's secure hardware or your password manager.

Upstream stores the same things as JSON files under `./data`. The mapping between the two is in
[worker/README.md](worker/README.md#how-it-works).

## Configuration

Everything openGym reads lives in one of three places, and **[docs/CONFIG.md](docs/CONFIG.md)**
is the full reference:

| | Where | In git |
| --- | --- | --- |
| **Generic config** — bindings, cron, compatibility date | [`wrangler.jsonc`](wrangler.jsonc) | yes |
| **This deployment** — hostname, database, policy choices | [`instance.jsonc`](instance.jsonc) | yes |
| **Secrets** — `SESSION_SECRET`, the VAPID pair, `ADMIN_UIDS` | `wrangler secret put` | **no** |

`wrangler.jsonc` deliberately says nothing about any particular instance — that is what makes the
Deploy button above work for a stranger — so **if you fork this, `instance.jsonc` is the one file
you edit.** `npm run deploy:instance` merges it over the generic config and deploys the result;
`npm run deploy` ignores it.

The port and proxy variables the Docker stack needed (`PORT`, `WEB_PORT`, `NGINX_PORT`,
`BACKEND`) have no meaning here — one Worker serves both halves, so there is nothing to proxy.

## Roadmap

Rough, community-driven — ideas and PRs welcome:

- [x] Standalone mobile app — Android APK to sideload ([download](https://opengym.duarte-santos.ch)); on iOS as a self-hosted PWA (no store listings planned)
- [x] Automatic progression programs (linear, Greyskull LP, double progression) with stalls and deloads
- [x] Estimated 1RM per exercise
- [ ] Percentage / training-max programming (5/3/1-style) on top of the progression engine
- [ ] More starter plans (upper/lower, full-body, 5×5)
- [x] Importers from FitNotes / Strong / Hevy (CSV, or Hevy Pro API key — workouts and/or weigh-ins), including the RPE they record, and body weight from Apple Health
- [x] Effort per set — RIR or RPE, whichever scale you think in
- [ ] Body measurements (waist, arms…) alongside weight
- [ ] Per-exercise notes & plate calculator
- [ ] Exercise instructions in German & Portuguese (Portugal); the separately curated Brazilian Portuguese pack is complete

## Tech

React 19 + Vite (React Router, Zustand) · Cloudflare Workers · D1 · Durable Objects ·
WebAuthn · exercise data from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset)
(MIT metadata and instructions; media © Gym visual — see [License](#license)).
Two runtime dependencies on the server side, both in `worker/`: `@simplewebauthn/server` for
passkeys and `web-push` for notifications.

The training logic — progression rules, 1RM estimation, how a logged session is read back —
lives in pure functions under `frontend/src/lib/` with tests next to them: `npm test` in
`frontend/`. Vitest is a dev dependency; the app itself ships no runtime dependencies beyond
React, the router and Zustand.

The same pure helpers power an optional MCP server (`mcp/`) that lets an LLM client like
Claude Desktop read your data over stdio — see [mcp/README.md](mcp/README.md). Opt-in, not
in the Docker build.

## Community

- **[Discord](https://discord.gg/e62jY6fwVb)** — release announcements, self-hosting help and
  the back-and-forth that would be a slow issue thread. Quickest way to get an answer.
- **[Issues](https://gitlab.com/DuarteSantos8/opengym/-/issues)** — bugs, questions, self-hosting
  help and ideas. There are no Discussions here, so it all lives in one tracker: label a question
  `question` and an idea `idea`, and it gets treated as one rather than as agreed-on work. Use
  an issue over the Discord for anything the next person should be able to find by searching.
- **Login trouble?** Most of it is an `RP_ID`/`ORIGIN` mismatch — check
  [worker/README.md](worker/README.md) before opening an issue.
- **Merge requests** — [open one on GitLab](https://gitlab.com/DuarteSantos8/opengym/-/merge_requests); see
  [CONTRIBUTING.md](CONTRIBUTING.md).

> **On the GitHub repo:** `github.com/DuarteSantos8/openGym` is offline because the account was
> suspended. **GitLab is the home of the project** — same history, same tags, same releases, and
> the CI that builds the images and the APK runs there. (gitea.com/DuarteSantos/openGym was the
> first stopgap and is now only a mirror.) Old GitHub issue and PR numbers in
> [CHANGELOG.md](CHANGELOG.md) are kept as plain references; they don't map onto GitLab's
> numbering.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: more starter
plans, exercise-data languages, import from other trackers. **A ⭐ helps more people find it.**

openGym is free and stays free: AGPL, no subscription, no paid tier, nothing held back for
sponsors. If it replaced a paid tracker for you and you want to chip in, there's a coffee button
below (and a badge at the top) — a star, a bug report or a merge request is worth just as much.

<!-- GitLab has no Sponsor button the way GitHub's FUNDING.yml gave one, so the link has to
     stand on its own here. .github/FUNDING.yml stays put for the day that account returns. -->

<a href="https://buymeacoffee.com/duartesantos" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
       alt="Buy Me A Coffee"
       style="height: 60px !important;width: 217px !important;">
</a>

## License

**openGym's own code** is [GNU AGPL v3.0](LICENSE) — free and open source. You can self-host,
use, modify and share it; if you run a modified version as a network service, you must offer that
version's source under the same license. Nobody can turn openGym into a closed, proprietary
product.

**Third-party content is not, and openGym cannot sublicense it.** The exercise metadata and
instruction text originate from [ExerciseDB v1](https://exercisedb.dev/) and reach openGym through
[hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) under the
**MIT** license. The exercise images and animations are third-party content covered by neither
that license nor the AGPL, and their ownership is **currently unresolved** — the upstream dataset
attributes them to [Gym visual](https://gymvisual.com/) under a non-transferable permission, while
[ExerciseDB/AscendAPI](https://exercisedb.io/faq) claims to be their creator and owner. A
clarification has been requested. openGym does not redistribute them (your instance fetches them
at first run) and does not relicense them. To reuse that media yourself, clear it with the rights
holder first.

Full third-party notices, including the body-diagram geometry: **[NOTICE.md](NOTICE.md)**.
