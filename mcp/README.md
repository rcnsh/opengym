# openGym MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) bridge that lets an external LLM
application (Claude Desktop, Cursor, Cline, Continue, etc.) read your openGym profile —
routines, workouts, body-weight log, estimated 1RMs, and muscle balance.

It is read-only and runs locally as a stdio process spawned by the LLM client — nothing to
deploy, no port to open, no change to your instance. It has two backends:

- **Your Cloudflare instance, over HTTPS** — fetches your profile from the Worker. This is the
  normal setup for this fork: the state lives in D1, so there is no data directory to read.
  Authenticated with an ordinary openGym session token you mint from Settings.
- **Local files** — reads a `state-<uid>.json` state document off disk. No authentication,
  because the file is already on the machine. Use it against a backup, a JSON export from
  Settings, or the `./data` directory of an upstream (Node + JSON files) openGym instance.

Either way the LLM never sees passkeys, VAPID keys or session secrets: it reads exactly the
per-user state the app itself syncs, and nothing else.

The numbers it answers with are computed by the **same pure functions the React UI uses**
(`frontend/src/lib/*.js`) — `estimate1RM`, `loadOfWorkouts`, `effectiveRoutine`, etc. — so a
"what's my bench 1RM?" answer matches the Stats screen exactly.

> Read-only. Write tools are planned but not shipped — see **Roadmap** below.

## Quick start

### 1. Install

```bash
cd mcp
npm install
```

### 2. Point it at your data

Two backends. Setting `OPENGYM_URL` selects the remote one; leaving it unset reads from disk.

**Cloudflare instance — reads over HTTPS**

Point the server at your instance and give it a session token:

```bash
OPENGYM_URL=https://gym.example.com OPENGYM_TOKEN=<token> node src/index.js
```

Mint the token from a signed-in browser: **Settings → Pair the mobile app**, which shows a
one-shot code good for five minutes, then redeem it:

```bash
curl -s -X POST https://gym.example.com/api/pair/redeem \
  -H 'Content-Type: application/json' -d '{"code":"YOUR-CODE"}'
```

The `token` in the response is what goes in `OPENGYM_TOKEN`. This is the same pairing flow the
mobile app uses, so it needs no extra API surface and no Cloudflare credentials.

The token identifies one profile, so `OPENGYM_UID` is neither needed nor read in this mode. It is
a normal session token: it expires after `SESSION_DAYS` (90 by default), and is invalidated by
"sign out everywhere" or by rotating `SESSION_SECRET`. When that happens the server reports
exactly that on startup — mint a new code and swap it in.

**Treat the token as a password.** It grants read access to that profile, and write access to it
through the API, for as long as it is valid. Keep it out of shell history and out of git.

**Local files — reads a state document off disk**

The layout is upstream's: one `state-<uid>.json` per profile, optionally alongside a `db.json`
holding the profile list. A Cloudflare instance writes neither — its state is in D1 — so this
backend is for data that is already on your disk: a backup of an upstream `./data` directory, a
directory served by an upstream Node instance you still run, or a **Settings → Backup export**
JSON saved as `state-<uid>.json` (the export file *is* the state document, byte for byte).

```bash
# a directory holding exactly one state-<uid>.json — the uid is auto-detected:
OPENGYM_DATA=/path/to/data node src/index.js

# several profiles in one directory, or just to be explicit:
OPENGYM_UID=<your-uid> OPENGYM_DATA=/path/to/data node src/index.js
```

`OPENGYM_DATA` defaults to `./data` under the working directory. `db.json` is optional: it only
supplies the profile's display name, and lets the uid be resolved when a profile exists but has
never synced a state document. With several profiles present, the server refuses to guess and
lists the ids to choose between.

### 3. Register with your LLM client

Add the server to your LLM client's MCP config. For Claude Desktop, edit
`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_URL": "https://gym.example.com",
        "OPENGYM_TOKEN": "<token from the pairing redeem above>"
      }
    }
  }
}
```

To read local files instead, swap the `env` block — the `command` and `args` are identical:

```jsonc
{
  "mcpServers": {
    "opengym": {
      "command": "node",
      "args": ["/absolute/path/to/openGym/mcp/src/index.js"],
      "env": {
        "OPENGYM_DATA": "/absolute/path/to/your/data",
        "OPENGYM_UID": "<your-uid>"   // optional — auto-detected if there's one profile
      }
    }
  }
}
```

For Cursor and other MCP-compatible clients, see the client's MCP docs — the same `command` +
`args` + `env` shape is what every stdio MCP server expects.

Restart the client; you should see the openGym tools appear with "serving profile \<name\>" on
the server's stderr.

## Tools

Eight read-only tools in v1:

| Tool | What it answers |
|---|---|
| `list_routines` | What routines are saved in my profile? (names + exercise counts) |
| `get_routine` | What does the Push Day routine prescribe? (sets/reps/weight per exercise) |
| `get_week_plan` | What's on my plan this week, including today with any date-specific override? |
| `list_workouts` | Recent sessions — newest first, with dates, sets done/planned, volume, duration, PRs. |
| `get_workout` | Full set-by-set breakdown of one session, by `workout_id` or by date. On a day with two sessions the date alone returns both ids to pick from rather than guessing at one. |
| `get_bodyweight` | Weigh-ins with the latest weight, the goal line, and deltas vs goal. |
| `estimate_1rm` | All-time best 1RM for an exercise + the trend, or a PR table across all exercises. |
| `muscle_balance` | Which muscles I've trained this week/month/all-time, ranked + which I've neglected. |

Each tool returns JSON the LLM can format as it likes; structured fields (sets, dates, levels)
are pre-formatted into human-readable labels in `src/labels.js` so the LLM doesn't need to
re-interpret them.

## How it reuses the training logic

The MCP server imports the training helpers under `frontend/src/lib/` directly as Node ESM
and calls the same functions the React UI does (`history.js`, `onerm.js`, `muscles.js`,
`exercises.js`). The numbers it returns match what the Stats screen shows, because they are
the same code.

The one lib file that wasn't Node-safe was `i18n.js` (Vite's `import.meta.glob` at module
top level) — split into `i18n-core.js` (pure, Node-safe) + `i18n.js` (Vite/React bits,
re-exports from core). `exercises.js` got a one-line `import.meta.env || {}` guard. No new
dependencies landed in `frontend/`, no public exports changed.

## Design constraints honoured

- **Two runtime dependencies:** the MCP SDK and `zod` for the tool schemas. No database driver,
  no HTTP framework, no Cloudflare SDK.
- **Nothing added to the deployment.** The stdio transport is spawned by the LLM client, so the
  Worker is untouched — no new route, no new binding, no new D1 table.
- **No new auth mechanism.** On local files the filesystem is the boundary. Against a Cloudflare
  instance it reuses the existing device-pairing token rather than inventing anything. No passkey
  material, VAPID keys or session secrets ever cross either.
- **No telemetry.** Exits when the LLM client disconnects. The only network traffic it can make
  is to your own instance, and only when you set `OPENGYM_URL` — the local-file backend reads
  JSON off disk and opens no sockets at all.

## Tests

```bash
cd mcp && npm test
```

45 cases seeding state from `frontend/src/lib/demoSeed.js` (the same deterministic fixture
the public demo runs on). Pins JSON shape and the user-facing edge cases: rest-day override,
missing routine, zero-workout history, no synced state, superset links, three 1RM formulas.
"Today" is pinned via `vi.useFakeTimers({ now: ..., toFake: ['Date'] })` so date-dependent
tools see consistent values regardless of when the suite runs. The pure lib functions have
their own suite in `frontend/src/lib/*.test.js`.

## Roadmap

- **Done:** read-only stdio, 8 tools, the local-file backend, and an HTTPS backend for the
  Cloudflare deployment authenticated with a device-pairing token.
- **Phase 1.5:** a `progression_next` tool (what does the policy prescribe next?). No new
  deps; small surface area.
- **Phase 2:** read+write. The remote backend already carries a token that the API accepts for
  writes, so the auth half is solved there; what remains is the conflict problem — both backends
  would be doing a read-modify-write of the whole state document against a web UI doing the same,
  and `PUT /api/data` is last-write-wins. Tools: `log_workout`, `add_bodyweight`, `edit_routine`,
  `assign_weekday`, `override_day`.
- **Phase 3:** Streamable HTTP transport, so a client that cannot spawn a local process reaches
  the bridge over the network instead of over stdio. Same tool implementations, second transport
  — the MCP SDK supports both behind one tool registration.

## License

AGPL-3.0-or-later, same as openGym.
