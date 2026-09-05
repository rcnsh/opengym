/* Integration smoke test for the Worker.

   The passkey ceremony itself cannot run headlessly — it needs a real authenticator — so this
   mints a session cookie directly with the dev SESSION_SECRET and drives everything behind it:
   session verification, the chunked state round-trip, presence, the admin routes, invites, the
   audit log, and session revocation.

   Needs a running dev server and a seeded user:

     npx wrangler d1 migrations apply DB --local
     npx wrangler d1 execute DB --local --command \
       "INSERT OR REPLACE INTO users (id,name,created) VALUES ('testuid000001','tester','2026-01-01T00:00:00.000Z')"
     npm run dev &
     npm run test:smoke

   ADMIN_UIDS must include testuid000001 in .dev.vars for the admin assertions to pass. */
import crypto from 'node:crypto';
import fs from 'node:fs';

const varsFile = process.argv[2] || '.dev.vars';
const vars = Object.fromEntries(fs.readFileSync(varsFile, 'utf8')
  .split('\n').filter(Boolean).filter(l => l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
if (!vars.SESSION_SECRET) {
  console.error(`no SESSION_SECRET in ${varsFile} — see worker/README.md`);
  process.exit(2);
}
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787';
const UID = 'testuid000001';

const sign = p => p + '.' + crypto.createHmac('sha256', vars.SESSION_SECRET).update(p).digest('base64url');
const cookieFor = (uid, sv) => 'gymsid=' + sign(`${uid}:${Date.now() + 86400000}:${sv}`);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + detail}`);
  ok ? pass++ : fail++;
};
const call = async (path, opts = {}, cookie) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
      ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {})
    }
  });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const c = cookieFor(UID, 0);

let r = await call('/api/me', {}, c);
check('session cookie is accepted', r.body?.user?.id === UID, JSON.stringify(r.body));

r = await call('/api/me', {}, 'gymsid=' + sign(`${UID}:${Date.now() + 86400000}:0`) + 'x');
check('tampered signature rejected', r.body?.user === null, JSON.stringify(r.body));

r = await call('/api/me', {}, 'gymsid=' + sign(`${UID}:${Date.now() - 1000}:0`));
check('expired cookie rejected', r.body?.user === null, JSON.stringify(r.body));

// Regression: the paired mobile app writes with a Bearer token from the Capacitor WebView, whose
// origin is https://localhost and whose Sec-Fetch-Site is cross-site. Both CSRF checks reject
// that, so the Bearer exemption is the only thing letting it through. Dropping it refuses every
// write from the app while pairing still succeeds (pair/redeem is exempt), which reads like a
// sync bug rather than a CSRF one.
const bearer = { Authorization: 'Bearer ' + sign(`${UID}:${Date.now() + 86400000}:0`) };
r = await fetch(BASE + '/api/data', {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Origin: 'https://localhost', 'Sec-Fetch-Site': 'cross-site', ...bearer
  },
  body: JSON.stringify({ state: { _ts: Date.now(), lang: 'en' } })
});
check('mobile app writes with a Bearer token from a foreign origin', r.status === 200,
  `HTTP ${r.status} — CSRF refused the Capacitor WebView`);

// A state large enough to span several 64 KB chunks, to prove reassembly.
const workouts = Array.from({ length: 900 }, (_, i) => ({
  d: '2026-0' + (1 + (i % 9)) + '-' + String(1 + (i % 28)).padStart(2, '0'),
  ex: [{ n: 'Bench Press', sets: [{ w: 60 + (i % 40), r: 8 }, { w: 60, r: 8 }] }]
}));
const state = {
  _ts: Date.now(), unit: 'kg', lang: 'en',
  reminder: { on: true, time: '07:30', tz: 'Europe/London' },
  week: [null, 'r1', null, 'r1', null, 'r1', null],
  routines: [{ id: 'r1', name: 'Full Body', emoji: '🏋️', ex: [{ n: 'Bench Press' }] }],
  bodyweight: [{ d: '2026-09-01', kg: 78.4 }],
  workouts,
  active: { shouldBeStripped: true }
};
const size = JSON.stringify(state).length;

r = await call('/api/data', { method: 'PUT', body: JSON.stringify({ state }) }, c);
check(`PUT /api/data accepts a ${(size / 1024).toFixed(0)} KB state`, r.status === 200, JSON.stringify(r.body));

r = await call('/api/data', {}, c);
check('state round-trips across chunks', JSON.stringify(r.body.state.workouts) === JSON.stringify(workouts),
  `got ${r.body?.state?.workouts?.length} workouts`);
check('in-progress workout stripped', r.body.state.active === undefined, JSON.stringify(r.body.state.active));

r = await call('/api/activity', { method: 'POST', body: JSON.stringify({ active: true, name: 'Full Body', exIdx: 1, exTotal: 4, setsDone: 3, setsTotal: 12, startedAt: Date.now() }) }, c);
check('presence heartbeat accepted', r.status === 200, JSON.stringify(r.body));

r = await call('/api/admin/users', {}, c);
const me = r.body?.users?.find(u => u.id === UID);
check('admin list reads denormalised counts', me?.workouts === 900, `workouts=${me?.workouts}`);
check('admin list shows live presence', me?.live?.name === 'Full Body', JSON.stringify(me?.live));
check('admin list resolves lastSync', me?.lastSync === state._ts, `${me?.lastSync}`);

r = await call('/api/admin/invites/new', { method: 'POST', body: JSON.stringify({ note: 'a friend' }) }, c);
const code = r.body?.invite?.code;
check('admin mints an invite', /^[0-9A-F]{16}$/.test(code || ''), code);

r = await call('/api/register/options', { method: 'POST', body: JSON.stringify({ name: 'friend', code }) });
check('minted invite is accepted for signup', !!r.body?.cid, JSON.stringify(r.body).slice(0, 90));

r = await call('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) }, c);
check('unused invite can be revoked', r.status === 200, JSON.stringify(r.body));

r = await call('/api/register/options', { method: 'POST', body: JSON.stringify({ name: 'friend', code }) });
check('revoked invite is refused', r.status === 403, JSON.stringify(r.body));

r = await call('/api/push/rest-timer', { method: 'POST', body: JSON.stringify({ seconds: 90 }) }, c);
check('rest timer schedules a DO alarm', r.status === 200, JSON.stringify(r.body));
r = await call('/api/push/rest-timer/cancel', { method: 'POST', body: '{}' }, c);
check('rest timer cancels', r.status === 200, JSON.stringify(r.body));

r = await call('/api/admin/audit', {}, c);
check('audit log is readable', Array.isArray(r.body?.events) && r.body.events.length > 0, JSON.stringify(r.body).slice(0, 90));
check('audit recorded invite creation',
  r.body.events.some(e => e.ev === 'admin.invite.create'), r.body.events.map(e => e.ev).join(','));

r = await call('/api/logout/all', { method: 'POST', body: '{}' }, c);
check('logout/all succeeds', r.status === 200, JSON.stringify(r.body));
r = await call('/api/me', {}, c);
check('old cookie dies after logout/all', r.body?.user === null, JSON.stringify(r.body));
r = await call('/api/me', {}, cookieFor(UID, 1));
check('re-signed cookie works after sv bump', r.body?.user?.id === UID, JSON.stringify(r.body));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
