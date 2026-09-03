/* opengym-mcp state — read-only, with two backends.

   FILE (default): reads ./data/state-<uid>.json + db.json straight off disk, cached with an
   fs.watch + mtime fallback so a session the api server just wrote is visible on the next tool
   call without a restart. This is the Docker Compose deployment.

   REMOTE (set OPENGYM_URL): fetches the same two things over HTTPS from a running instance,
   authenticated with a Bearer token. Needed for the Cloudflare deployment, where the state lives
   in D1 and there is no ./data directory to read at all.

   getState()/getUser() stay synchronous either way — index.js awaits refresh() before each tool
   call, so tools.js needs no knowledge of which backend is in use. */
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')

// Remote backend. The token is a normal openGym session token, minted by redeeming a pairing
// code from Settings — the same one-shot flow the mobile app uses, so this needs no new API
// surface and no Cloudflare credentials.
const REMOTE = (process.env.OPENGYM_URL || '').replace(/\/+$/, '')
const TOKEN = (process.env.OPENGYM_TOKEN || '').trim()
// Long enough that a burst of tool calls in one answer costs a single round trip, short enough
// that a set logged mid-conversation shows up.
const REMOTE_TTL_MS = 15000
let _fetchedAt = 0
let _remoteUser = null
let _remoteError = null

// null = no state file (brand-new account); undefined = not yet loaded.
let _state = undefined
let _db = undefined
let _uid = null
let _watcher = null
let _loadedMtime = 0    // mtimeMs we last read at — used to catch watcher omissions

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function reloadDb() { _db = readJsonOrNull(path.join(DATA_DIR, 'db.json')) || { users: [], creds: [], subs: [], invites: [] } }

function stateFile(uid) {
  return path.join(DATA_DIR, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')
}

// Pick the uid: OPENGYM_UID env, else the only state-* file, else the only user in db.json.
// Throws listing the options if ambiguous. The sanitiser on stateFile() keeps a sneaky
// '..' in OPENGYM_UID harmless.
function resolveUid() {
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envUid)) throw new Error(`OPENGYM_UID contains characters that aren't safe in a filename: ${JSON.stringify(envUid)}`)
    return envUid
  }
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/^state-/, '').replace(/\.json$/, ''))
  if (files.length === 1) return files[0]
  if (files.length === 0) {
    reloadDb()
    if (_db.users.length === 1) return _db.users[0].id
    if (_db.users.length === 0) throw new Error(`no openGym users found in ${path.join(DATA_DIR, 'db.json')} — sign in at least once on a device`)
    // Multiple users in db.json but no state files yet — list their ids, not the (empty)
    // files list. Hit when accounts exist but none has signed in on a device.
    throw new Error(
      `multiple openGym users found — set OPENGYM_UID to one of: ${_db.users.map(u => u.id).join(', ')}\n` +
      `  (look them up in ${path.join(DATA_DIR, 'db.json')} under "users"[].id)`
    )
  }
  throw new Error(
    `multiple openGym users found — set OPENGYM_UID to one of: ${files.join(', ')}\n` +
    `  (look them up in ${path.join(DATA_DIR, 'db.json')} under "users"[].id)`
  )
}

/* ---------- remote backend ---------- */

async function fetchJson(pathname) {
  let res
  try {
    res = await fetch(REMOTE + pathname, {
      headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' }
    })
  } catch (e) {
    throw new Error(`cannot reach ${REMOTE} — ${e.message}`)
  }
  if (res.status === 401) {
    throw new Error(
      `OPENGYM_TOKEN was rejected by ${REMOTE}. Tokens expire (SESSION_DAYS, 90 by default) and ` +
      `are invalidated by "sign out everywhere" or a SESSION_SECRET rotation — mint a new one ` +
      `from Settings → pair a device.`
    )
  }
  if (!res.ok) throw new Error(`${pathname} returned HTTP ${res.status}`)
  return await res.json()
}

// Refreshed at most every REMOTE_TTL_MS. Errors are cached too, so a dead instance reports the
// same message on every tool call instead of stalling each one on a fresh timeout.
async function refreshRemote(force) {
  if (!force && Date.now() - _fetchedAt < REMOTE_TTL_MS) {
    if (_remoteError) throw _remoteError
    return
  }
  _fetchedAt = Date.now()
  _remoteError = null
  try {
    const me = await fetchJson('/api/me')
    if (!me?.user?.id) throw new Error(`${REMOTE} did not recognise OPENGYM_TOKEN — no profile returned`)
    _remoteUser = { id: me.user.id, name: me.user.name || 'Profile', created: me.user.created || null }
    _uid = me.user.id
    const data = await fetchJson('/api/data')
    // null state is a real answer: a profile that has never synced from a device.
    _state = data?.state ? Object.assign({}, defaultsShape(), data.state) : null
  } catch (e) {
    _remoteError = e
    throw e
  }
}

// Called by index.js before every tool handler. No-op on the file backend, which has its own
// mtime check inside getState().
export async function refresh() {
  if (!REMOTE) return
  await refreshRemote(false)
}

/* ---------- file backend ---------- */

// Idempotent. Picks the uid, loads db.json, attaches the watcher, primes state.
export function init() {
  if (REMOTE) {
    if (!TOKEN) throw new Error('OPENGYM_URL is set but OPENGYM_TOKEN is not — both are required for a remote instance')
    return
  }
  if (_uid !== null) return
  if (!fs.existsSync(DATA_DIR)) throw new Error(`OPENGYM_DATA dir does not exist: ${DATA_DIR}`)
  _uid = resolveUid()
  reloadDb()
  const file = stateFile(_uid)
  if (fs.existsSync(file)) {
    _state = readJsonOrNull(file)
    if (_state) _state = Object.assign({}, defaultsShape(), _state)
    try { _loadedMtime = fs.statSync(file).mtimeMs } catch {}
  }
  if (_watcher) _watcher.close()
  // fs.watch is best-effort: the api server's atomic write at PUT /api/data is the source of
  // truth, and a stale read just gets corrected on the next change or the next tool call.
  try {
    _watcher = fs.watch(file, () => {
      // On change, simply clear the cache — the next getState() will re-read. Avoids reading
      // twice if the watcher fires multiple events for one atomic-write (rename + create).
      _state = undefined
      _loadedMtime = 0
    })
    // Unref'd, or the watcher alone holds the event loop open and the process outlives the
    // client that spawned it — "exits when the LLM client disconnects" stops being true the
    // moment there is a state file to watch. Most clients kill the child anyway, but one that
    // merely closes the pipe would leak a process per session. Watching is unaffected: the
    // stdio transport is what keeps the loop alive while a client is actually attached.
    _watcher.unref()
  } catch { /* fs.watch unsupported on this platform; tools will re-read on mtime change */ }
}

// Returns the state object, or null for a fresh account that never signed in on a device.
export function getState() {
  // Remote: whatever the last refresh() put in the cache. index.js awaits that before every
  // handler, so this is never staler than REMOTE_TTL_MS.
  if (REMOTE) return _state === undefined ? null : _state
  init()
  const file = stateFile(_uid)
  // Re-read if the file's mtime changed since our last load — covers watcher omissions and
  // platforms with no fs.watch.
  let mtime
  try { mtime = fs.statSync(file).mtimeMs } catch {
    return _state === undefined ? null : _state
  }
  if (_state === undefined || mtime !== _loadedMtime) {
    const fresh = readJsonOrNull(file)
    if (fresh) {
      // Same shape the frontend builds on pullState — defaults merged with stored state so any
      // field the app added since the snapshot was last saved shows up undefined-safe.
      _state = Object.assign({}, defaultsShape(), fresh)
      _loadedMtime = mtime
    } else if (_state === undefined) {
      _state = null  // no state file at all — never signed in on a device
    }
  }
  return _state
}

// Returns the user record (id + name). No passkey material, no VAPID keys, no push subs.
export function getUser() {
  if (REMOTE) return _remoteUser || { id: _uid, name: 'Profile', created: null }
  init()
  const u = _db.users.find(x => x.id === _uid) || { id: _uid, name: 'Profile', created: null }
  return { id: u.id, name: u.name, created: u.created || null }
}

export const dataDir = () => DATA_DIR

// Test-only: work against a passed-in state, not the disk.
export function _seedStateForTests(state) {
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }], creds: [], subs: [], invites: [] }
  _state = state
  _loadedMtime = Number.MAX_SAFE_INTEGER   // never re-read from disk in a test
  if (_watcher) { _watcher.close(); _watcher = null }
}

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}
