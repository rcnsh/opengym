-- openGym on Cloudflare — D1 schema.
-- Replaces api/server.js's two JSON files (db.json, state-<uid>.json) plus data/audit.log.
-- Table/column names track the upstream object shapes so the store layer stays a thin mapping.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created       TEXT NOT NULL,               -- ISO string, as upstream user.created
  sv            INTEGER NOT NULL DEFAULT 0,  -- session version; POST /api/logout/all bumps it
  admin         INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  invited_by    TEXT,
  last_reminder TEXT,                        -- ISO date; one day-reminder per user per day
  -- Denormalised from the state blob on every PUT /api/data. Upstream's reminder loop reads every
  -- user's whole state file every 10s; here the cron runs once a minute and must not pay that, so
  -- the handful of fields it actually needs are kept beside the user. Same for the admin list,
  -- which upstream builds by reading every state file on each request.
  reminder_on   INTEGER NOT NULL DEFAULT 0,
  reminder_time TEXT,
  reminder_tz   TEXT,
  lang          TEXT,
  last_sync     INTEGER,                     -- state._ts
  workouts      INTEGER NOT NULL DEFAULT 0,
  last_workout  TEXT
);
CREATE INDEX IF NOT EXISTS users_reminder ON users(reminder_on, reminder_time);

-- Login uses discoverable credentials (residentKey: 'required', allowCredentials: []), so the
-- credential id is the lookup key and usernames are deliberately not unique — same as upstream.
CREATE TABLE IF NOT EXISTS creds (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,                 -- base64url
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS creds_user ON creds(user_id);

CREATE TABLE IF NOT EXISTS subs (
  endpoint  TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh    TEXT NOT NULL,
  auth      TEXT NOT NULL,
  created   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subs_user ON subs(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  created    TEXT NOT NULL,
  created_by TEXT,
  used_by    TEXT,
  used_at    TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0
);

-- state-<uid>.json. Split across rows because D1 caps a row at 2 MB and a SQL statement at 100 KB;
-- CHUNK in store.js is the knob. Reassembled in seq order on read.
CREATE TABLE IF NOT EXISTS state_chunks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  body    TEXT NOT NULL,
  PRIMARY KEY (user_id, seq)
);

-- Upstream keeps these in process memory with a sweeping setInterval. A Worker has neither, so
-- they land here with an explicit expiry and are swept lazily on read.
CREATE TABLE IF NOT EXISTS challenges (
  cid  TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  exp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS challenges_exp ON challenges(exp);

CREATE TABLE IF NOT EXISTS pairings (
  code TEXT PRIMARY KEY,
  uid  TEXT NOT NULL,
  exp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pairings_exp ON pairings(exp);

-- Live-workout heartbeat. Upstream keeps this in a process-memory Map and calls it "purely
-- ephemeral — never persisted"; it is persisted here only because a Worker has no memory between
-- requests. It is still throwaway: every row is expired by PRESENCE_TTL on read, and nothing but
-- the admin dashboard ever looks at it. In D1 rather than in the per-user Durable Object because
-- the admin list wants every user's presence at once — one query here, N object calls there.
CREATE TABLE IF NOT EXISTS presence (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  ex_idx     INTEGER NOT NULL DEFAULT 0,
  ex_total   INTEGER NOT NULL DEFAULT 0,
  sets_done  INTEGER NOT NULL DEFAULT 0,
  sets_total INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- data/audit.log (JSONL). Retention is enforced with DELETE rather than by rewriting a file, but
-- the id sequence is never reset, so a clear still leaves a visible gap exactly as upstream's does.
CREATE TABLE IF NOT EXISTS audit (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  ev    TEXT NOT NULL,
  ok    INTEGER NOT NULL DEFAULT 1,
  uid   TEXT,
  name  TEXT,
  tgt   TEXT,
  tname TEXT,
  msg   TEXT,
  ip    TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
