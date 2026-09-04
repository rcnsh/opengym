/* Test-runner shims. Both exist to make a local run mean the same thing as a CI run; neither
   affects the app, and both are inert on the Node version CI uses. */

/* Pin the timezone. Some tests assert on "the same local day" — parseHevyWorkouts merging two
   Hevy sessions, for one — and silently assume the runner sits near UTC. Run them in UTC+8 and a
   18:00Z session lands on the next local day and stops merging. CI runs in UTC and is green, so
   UTC is the timezone these were written against; setting it here makes a local run mean the
   same thing as a CI run instead of depending on where you are. */
process.env.TZ = 'UTC'

/* Web Storage.

   Node 26 ships an experimental built-in `localStorage`, exposed on globalThis as a getter that
   returns `undefined` unless the process was started with --localstorage-file. That accessor
   shadows the one happy-dom would otherwise install, so under Node 26 both globalThis.localStorage
   and window.localStorage are undefined and every test touching the persisted store dies on
   `localStorage.clear()`. On Node 22 — what CI runs — happy-dom's implementation is present and
   everything below is skipped.

   It has to be a real class, not an object literal: RoutineEdit.drag.test.jsx counts writes with
   `vi.spyOn(Storage.prototype, 'setItem')`, which only intercepts anything if the methods live on
   a prototype the instance inherits from. Per-instance data hangs off a WeakMap so the prototype
   methods stay shared. */

const cells = new WeakMap()

class MemoryStorage {
  constructor() { cells.set(this, new Map()) }
  get length() { return cells.get(this).size }
  key(i) { return Array.from(cells.get(this).keys())[i] ?? null }
  getItem(k) { const m = cells.get(this); return m.has(String(k)) ? m.get(String(k)) : null }
  setItem(k, v) { cells.get(this).set(String(k), String(v)) }
  removeItem(k) { cells.get(this).delete(String(k)) }
  clear() { cells.get(this).clear() }
}

const define = (target, name, value) =>
  Object.defineProperty(target, name, { value, configurable: true, writable: true })

const missing = ['localStorage', 'sessionStorage'].filter(n => globalThis[n] == null)

if (missing.length) {
  // happy-dom exports a Storage class, but with no working instance behind it on this runtime.
  // Replacing it keeps `Storage.prototype` and the live objects consistent, which is what the
  // spy above depends on.
  define(globalThis, 'Storage', MemoryStorage)
  for (const name of missing) {
    const value = new MemoryStorage()
    define(globalThis, name, value)
    // Keep window and globalThis pointing at the same object — the app reaches for the bare
    // global, the odd test reaches through window, and they must not diverge.
    if (globalThis.window && globalThis.window !== globalThis) define(globalThis.window, name, value)
  }
}
