/* opengym-worker — the api/server.js route table, on Cloudflare Workers.
   Same route keys, same request/response shapes, same audit events. What changes is underneath:
   node:http becomes fetch, the two JSON files become D1 (see store.js), and the process-memory
   Maps and timers become D1 rows and a Durable Object alarm.

   Handlers keep upstream's (req, res) shape via the shim at the bottom of this file, with a third
   `c` argument carrying per-request context — a Worker has no module-scope env to read from. */

import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import crypto from 'node:crypto';
import { Store } from './store.js';
import { config, sendPush } from './runtime.js';
// Imported from the upstream tree rather than copied: both are pure, dependency-free ESM, so they
// stay on the rebase path and the two runtimes can never disagree about wording or error text.
import { dayReminderPush, restTimerPush, testPush } from '../../api/push-messages.js';
import { verifyError } from '../../api/verify-error.js';

export { RestTimer } from './user-do.js';

const MAX_BODY = 5 * 1024 * 1024;
const MAX_SUBS_PER_USER = 20;
const PRESENCE_TTL = 70000;              // ~3.5x the 20s client heartbeat, as upstream
const CHALLENGE_TTL = 5 * 60000;
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I — read off a screen

/* ---------- sessions (signed cookie) ---------- */

const sign = (secret, payload) =>
  payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function verifySig(secret, token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}

const sessionVersion = user => user.sv || 0;

function makeSession(c, user) {
  const exp = Date.now() + c.cfg.SESSION_DAYS * 86400000;
  return sign(c.cfg.SECRET, user.id + ':' + exp + ':' + sessionVersion(user));
}

function sessionCookie(c, user) {
  const maxAge = c.cfg.SESSION_DAYS * 86400;
  return `${c.cfg.COOKIE}=${makeSession(c, user)}; HttpOnly; Path=/; SameSite=Lax;` +
         `${c.cfg.SECURE ? ' Secure;' : ''} Max-Age=${maxAge}`;
}

const clearCookie = c =>
  `${c.cfg.COOKIE}=; HttpOnly; Path=/; SameSite=Lax;${c.cfg.SECURE ? ' Secure;' : ''} Max-Age=0`;

// Every value for a given name, in the order the browser sent them. Not reduced to one entry:
// picking a winner silently would hand a shadowing cookie the session.
function cookieValues(req, name) {
  const out = [];
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

function sessionTokens(c, req) {
  const names = c.cfg.COOKIE === c.cfg.LEGACY_COOKIE ? [c.cfg.COOKIE] : [c.cfg.COOKIE, c.cfg.LEGACY_COOKIE];
  const out = [];
  for (const name of names) out.push(...cookieValues(req, name));
  // The paired mobile app has no cookie jar shared with this origin, so it presents the same
  // signed token as a bearer instead.
  const auth = req.headers.authorization || '';
  if (/^Bearer /i.test(auth)) out.push(auth.slice(7).trim());
  return out;
}

async function readSession(c, req) {
  for (const token of sessionTokens(c, req)) {
    const payload = verifySig(c.cfg.SECRET, token);
    if (!payload) continue;
    const [uid, exp, ver] = payload.split(':');
    if (!uid || !(+exp > Date.now())) continue;
    const user = await c.store.getUser(uid);
    if (!user || user.disabled) continue;
    // Cookies minted before `sv` existed have no third field and read as version 0, matching a
    // user who has never bumped — they stay valid until they expire.
    if (sessionVersion(user) !== (+ver || 0)) continue;
    return user;
  }
  return null;
}

const isAdmin = (c, user) => !!user && (user.admin === true || c.cfg.ADMIN_UIDS.includes(user.id));

async function requireAdmin(c, req, res) {
  const user = await readSession(c, req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(c, user)) { json(res, 403, { error: 'not an admin' }); return null; }
  return user;
}

/* ---------- CSRF ---------- */

// Exempt because they have to keep working from the mobile WebView, whose origin is never ORIGIN.
const CSRF_EXEMPT = new Set([
  'POST /api/register/options', 'POST /api/register/verify',
  'POST /api/login/options', 'POST /api/login/verify',
  'POST /api/pair/redeem'
]);

function csrfOk(c, req, key) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (CSRF_EXEMPT.has(key)) return true;
  // Sec-Fetch-Site is set by the browser itself and no page can forge it, and it states exactly
  // the property wanted here — more precisely than comparing origins can.
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin.replace(/\/+$/, '') === c.cfg.ORIGIN;
}

/* ---------- challenges and pairing codes ---------- */

const randB64 = n => crypto.randomBytes(n).toString('base64url');

async function putChallenge(c, data) {
  const cid = randB64(16);
  await c.store.putChallenge(cid, data, Date.now() + CHALLENGE_TTL);
  return cid;
}

async function makePairCode(c) {
  for (let i = 0; i < 5; i++) {
    const code = Array.from(crypto.randomBytes(8))
      .map(b => PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length]).join('');
    if (!(await c.store.pairingExists(code))) return code;
  }
  throw new Error('could not mint a unique pairing code');
}

/* ---------- audit ---------- */

// All three headers are only as trustworthy as the proxy in front. On Cloudflare, CF-Connecting-IP
// is set by the edge and cannot be forged by the client, so it is the one that matters here.
function clientIp(c, req) {
  if (c.cfg.AUDIT_IP === 'off') return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim();
  const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;      // never store a header verbatim
  if (c.cfg.AUDIT_IP === 'full') return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
  const g = ip.split(':').filter(Boolean).slice(0, 3).join(':');
  return g ? g + '::/48' : null;
}

// Never throws: a log that cannot be written must not break signing in.
function audit(c, req, ev, f = {}) {
  if (!c.cfg.AUDIT_ON) return;
  const rec = { ts: Date.now(), ev, ok: f.ok !== false };
  if (f.user) { rec.uid = f.user.id; rec.name = String(f.user.name || '').slice(0, 40); }
  else {
    if (f.uid) rec.uid = f.uid;
    if (f.name) rec.name = String(f.name).slice(0, 40);
  }
  if (f.target) { rec.tgt = f.target.id; rec.tname = String(f.target.name || '').slice(0, 40); }
  if (f.msg) rec.msg = String(f.msg).slice(0, 120);
  const ip = clientIp(c, req);
  if (ip) rec.ip = ip;
  // Deliberately not awaited: the response should not wait on the log. waitUntil keeps the
  // Worker alive until the insert lands.
  c.ctx.waitUntil(c.store.audit(rec).catch(e => console.error('audit write failed', e.message)));
}

/* ---------- push ---------- */

// Upstream refuses endpoints that resolve to a private address, because its api container sits on
// the self-hoster's Docker network. A Worker has no private network to reach, so only the shape
// of the URL is still worth checking.
function pushEndpointError(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return 'invalid endpoint'; }
  if (u.protocol !== 'https:') return 'endpoint must be https';
  return null;
}

/* ---------- day reminders ---------- */

// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId, exactly as
// api/server.js duplicates it — a tiny pure helper, not worth sharing across runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}

// "Now" in an arbitrary IANA zone, so each user's reminder fires by their own clock.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; }   // unknown/invalid tz string — skip this user rather than guess
}

/* ---------- routes ---------- */

const routes = {
  'GET /api/health': async (req, res, c) => {
    const users = await c.store.listUsers();
    json(res, 200, { ok: true, users: users.length });
  },

  'GET /api/config': async (req, res, c) =>
    json(res, 200, { invite_only: c.cfg.INVITE_ONLY, allow_guest: c.cfg.ALLOW_GUEST }),

  'GET /api/me': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 200, { user: null });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(c, user) } });
  },

  'POST /api/register/options': async (req, res, c) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(body.code || '').trim().toUpperCase();
    if (c.cfg.INVITE_ONLY && !(await c.store.findUsableInvite(code))) {
      // The rejected code itself is never recorded — a near-miss guess in the log is a liability.
      audit(c, req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      return json(res, 403, { error: 'a valid invite code is required' });
    }
    const uid = randB64(12);
    const options = await generateRegistrationOptions({
      rpName: c.cfg.RP_NAME, rpID: c.cfg.RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = await putChallenge(c, { challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res, c) => {
    const body = await readBody(req);
    const ch = await c.store.takeChallenge(body.cid);
    if (!ch || !ch.uid) {
      audit(c, req, 'auth.register.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: ch.challenge,
        expectedOrigin: c.cfg.ORIGIN,
        expectedRPID: c.cfg.RP_ID,
        requireUserVerification: false
      });
    } catch (e) {
      // e.message can echo attacker-supplied response fields, so only the reason code is kept.
      audit(c, req, 'auth.register.fail', { ok: false, name: ch.name, msg: 'verify-error' });
      return json(res, 400, { error: verifyError(e, { rpId: c.cfg.RP_ID, origin: c.cfg.ORIGIN }) });
    }
    if (!verification.verified) {
      audit(c, req, 'auth.register.fail', { ok: false, name: ch.name, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    const { credential } = verification.registrationInfo;
    if (await c.store.getCred(credential.id)) {
      audit(c, req, 'auth.register.fail', { ok: false, name: ch.name, msg: 'credential-exists' });
      return json(res, 409, { error: 'credential already registered' });
    }
    // Re-check the invite at the last moment (it may have been used or revoked since options).
    let invite = null;
    if (c.cfg.INVITE_ONLY) {
      invite = await c.store.findUsableInvite(ch.code);
      if (!invite) {
        audit(c, req, 'auth.register.fail', { ok: false, name: ch.name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
      }
    }
    const user = { id: ch.uid, name: ch.name, created: new Date().toISOString(), sv: 0 };
    if (invite) user.invitedBy = invite.code;
    await c.store.insertUser(user);
    if (invite) await c.store.burnInvite(invite.code, user.id, user.created);
    await c.store.insertCred({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || []
    });
    audit(c, req, 'auth.register.ok', { user, msg: invite ? invite.code : null });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(c, user) } },
      { 'Set-Cookie': sessionCookie(c, user) });
  },

  'POST /api/login/options': async (req, res, c) => {
    const options = await generateAuthenticationOptions({
      rpID: c.cfg.RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = await putChallenge(c, { challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res, c) => {
    const body = await readBody(req);
    const ch = await c.store.takeChallenge(body.cid);
    if (!ch) {
      audit(c, req, 'auth.login.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const cred = await c.store.getCred(body.credential?.id);
    if (!cred) {
      // No credential id goes in the log: it is a stable handle for one passkey, and recording it
      // would let an admin correlate an unknown device across attempts.
      audit(c, req, 'auth.login.fail', { ok: false, msg: 'unknown-credential' });
      return json(res, 404, { error: 'unknown passkey — create a profile first' });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: ch.challenge,
        expectedOrigin: c.cfg.ORIGIN,
        expectedRPID: c.cfg.RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: Buffer.from(cred.publicKey, 'base64url'),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) {
      audit(c, req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'verify-error' });
      return json(res, 400, { error: verifyError(e, { rpId: c.cfg.RP_ID, origin: c.cfg.ORIGIN }) });
    }
    if (!verification.verified) {
      audit(c, req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    await c.store.setCredCounter(cred.id, verification.authenticationInfo.newCounter);
    const user = await c.store.getUser(cred.userId);
    if (!user) {
      audit(c, req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'user-missing' });
      return json(res, 500, { error: 'user missing' });
    }
    if (user.disabled) {
      audit(c, req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled' });
    }
    audit(c, req, 'auth.login.ok', { user });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(c, user) } },
      { 'Set-Cookie': sessionCookie(c, user) });
  },

  // The cookie is cleared either way; a logout with no valid session is not worth an entry.
  'POST /api/logout': async (req, res, c) => {
    const user = await readSession(c, req);
    if (user) audit(c, req, 'auth.logout', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(c) });
  },

  // Bumping `sv` invalidates every cookie ever issued for the account, on every device. Passkeys
  // are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await c.store.updateUser(user.id, { sv: sessionVersion(user) + 1 });
    audit(c, req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(c) });
  },

  'POST /api/pair/create': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const code = await makePairCode(c);
    await c.store.putPairing(code, user.id, Date.now() + CHALLENGE_TTL);
    audit(c, req, 'auth.pair.create', { user });
    json(res, 200, { code });
  },

  // No session required — the code IS the credential, one-shot and 5-minute-lived.
  'POST /api/pair/redeem': async (req, res, c) => {
    const body = await readBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    const p = await c.store.takePairing(code);
    if (!p) {
      audit(c, req, 'auth.pair.fail', { ok: false, msg: 'code-invalid' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    const user = await c.store.getUser(p.uid);
    if (!user || user.disabled) {
      audit(c, req, 'auth.pair.fail', { ok: false, uid: p.uid, msg: 'user-unavailable' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    audit(c, req, 'auth.pair.ok', { user });
    json(res, 200, {
      token: makeSession(c, user),
      user: { id: user.id, name: user.name, admin: isAdmin(c, user) }
    });
  },

  'GET /api/data': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { state: await c.store.readState(user.id) });
  },

  'PUT /api/data': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    await c.store.writeState(user.id, body.state);
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res, c) => json(res, 200, { key: c.cfg.VAPID_PUBLIC }),

  'POST /api/push/subscribe': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return json(res, 400, { error: 'invalid subscription' });
    }
    const bad = pushEndpointError(sub.endpoint);
    if (bad) return json(res, 400, { error: bad });
    // Only the two keys the push protocol needs are kept: `sub` is caller-supplied and would
    // otherwise put arbitrary fields into storage that every admin route reads back out.
    const keys = { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) };
    await c.store.putSub(user.id, sub.endpoint, keys, MAX_SUBS_PER_USER);
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    await c.store.removeSub(user.id, String(body.endpoint || ''));
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(c.store, c.cfg, user.id, testPush(user.lang));
    json(res, 200, { ok: true });
  },

  // Upstream holds an in-process setTimeout. Here the deadline goes to a Durable Object alarm,
  // which is the only thing on this platform that can outlive the request that set it.
  'POST /api/push/rest-timer': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    await restTimer(c, user.id).fetch('https://do/schedule', {
      method: 'POST',
      body: JSON.stringify({ userId: user.id, seconds: sec, lang: user.lang })
    });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await restTimer(c, user.id).fetch('https://do/cancel', { method: 'POST' });
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res, c) => {
    const user = await readSession(c, req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      await c.store.setPresence(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else await c.store.clearPresence(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */

  // Upstream reads every user's state file to build this. Here the same numbers come off the
  // users table, denormalised on each PUT /api/data — see store.writeState.
  'GET /api/admin/users': async (req, res, c) => {
    if (!(await requireAdmin(c, req, res))) return;
    const [list, live] = await Promise.all([
      c.store.listUsers(), c.store.livePresence(PRESENCE_TTL)
    ]);
    const users = await Promise.all(list.map(async u => ({
      id: u.id, name: u.name, created: u.created || null,
      disabled: !!u.disabled, admin: isAdmin(c, u), invitedBy: u.invitedBy || null,
      workouts: u.workouts || 0,
      lastWorkout: u.lastWorkout || null,
      lastSync: u.lastSync || null,
      hasPush: await c.store.hasPush(u.id),
      live: live.get(u.id) || null
    })));
    json(res, 200, { users, invite_only: c.cfg.INVITE_ONLY, now: Date.now() });
  },

  'GET /api/admin/user': async (req, res, c) => {
    if (!(await requireAdmin(c, req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = await c.store.getUser(id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = (await c.store.readState(u.id)) || {};
    json(res, 200, {
      user: {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(c, u), invitedBy: u.invitedBy || null
      },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res, c) => {
    const admin = await requireAdmin(c, req, res); if (!admin) return;
    const body = await readBody(req);
    const u = await c.store.getUser(body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(c, u)) return json(res, 400, { error: 'cannot disable an admin' });
    const disabled = !!body.disabled;
    await c.store.updateUser(u.id, { disabled });
    if (disabled) await c.store.clearPresence(u.id);   // drop them off "training now" at once
    audit(c, req, disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: u });
    json(res, 200, { ok: true, id: u.id, disabled });
  },

  'GET /api/admin/invites': async (req, res, c) => {
    if (!(await requireAdmin(c, req, res))) return;
    json(res, 200, { invites: await c.store.listInvites(), invite_only: c.cfg.INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res, c) => {
    const admin = await requireAdmin(c, req, res); if (!admin) return;
    const body = await readBody(req);
    // 16 hex chars = 64 bits. There is no rate limiting by design, and /api/register/options tells
    // a caller whether a code is good, so the code itself has to be the thing not worth guessing.
    let code;
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); }
    while (await c.store.inviteExists(code));
    const invite = {
      code, note: String(body.note || '').slice(0, 60),
      createdBy: admin.id, created: new Date().toISOString()
    };
    await c.store.insertInvite(invite);
    audit(c, req, 'admin.invite.create', { user: admin, msg: code });
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res, c) => {
    const admin = await requireAdmin(c, req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = await c.store.getInvite(String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.used_by) return json(res, 400, { error: 'already used — cannot revoke' });
    await c.store.dropInvite(inv.code);
    audit(c, req, 'admin.invite.revoke', { user: admin, msg: inv.code });
    json(res, 200, { ok: true });
  },

  /* ---------- activity log ---------- */

  // Newest first, paged by id rather than by offset: the log grows at the front of this view, so
  // an offset cursor would repeat a row whenever an event lands between two pages.
  'GET /api/admin/audit': async (req, res, c) => {
    if (!(await requireAdmin(c, req, res))) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, +q.get('limit') || 100));
    const before = +q.get('before') || Infinity;
    const { events, total } = await c.store.auditPage({ limit, before, cat: q.get('cat') || '' });
    json(res, 200, {
      events, total,
      nextBefore: events.length === limit ? events[events.length - 1].id : null,
      enabled: c.cfg.AUDIT_ON, ip_mode: c.cfg.AUDIT_IP,
      retention: { max: c.cfg.AUDIT_MAX, days: c.cfg.AUDIT_DAYS },
      now: Date.now()
    });
  },

  // Deleting the log is itself logged, and the id sequence is not reset — so a clear always leaves
  // a visible gap in the ids and cannot be used to quietly erase a trace.
  'POST /api/admin/audit/clear': async (req, res, c) => {
    const admin = await requireAdmin(c, req, res); if (!admin) return;
    await c.store.clearAudit();
    audit(c, req, 'admin.audit.clear', { user: admin });
    json(res, 200, { ok: true });
  }
};

const restTimer = (c, userId) => c.env.REST_TIMER.get(c.env.REST_TIMER.idFromName(userId));

/* ---------- node:http shim ---------- */

// The handlers above are written against node's (req, res). Rebuilding them around Request and
// Response would touch every one of them and make each upstream release a manual merge, so the
// two objects are faked instead and the whole table stays a line-for-line comparison.

function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}

function readBody(req) {
  return req._body;
}

function makeRes() {
  return {
    _status: 200, _headers: {}, _body: null, headersSent: false,
    setHeader(k, v) { this._headers[k] = v; },
    writeHead(code, headers) {
      this._status = code;
      if (headers) Object.assign(this._headers, headers);
      this.headersSent = true;
      return this;
    },
    end(body) { if (body != null) this._body = body; },
    toResponse() { return new Response(this._body, { status: this._status, headers: this._headers }); }
  };
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const cfg = config(env);

  if (!cfg.SECRET) {
    console.error('SESSION_SECRET is not set — every session would be forgeable. Refusing.');
    return Response.json({ error: 'server misconfigured' }, { status: 500 });
  }

  const res = makeRes();
  // Same-origin never triggers CORS, so this only matters for the paired mobile app calling in
  // from its own WebView origin. It carries no cookie (auth is the Authorization header instead),
  // so Allow-Credentials is deliberately never set — reflecting the origin here cannot expose the
  // cookie session to anyone.
  const origin = request.headers.get('origin');
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (request.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return res.toResponse();
  }

  const key = request.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return Response.json({ error: 'not found' }, { status: 404 });

  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  const req = { method: request.method, url: url.pathname + url.search, headers, _body: {} };

  const c = { env, ctx, cfg, store: new Store(env.DB) };

  if (!csrfOk(c, req, key)) {
    // Logged, not audited: this is reachable without a session, and an entry per attempt would
    // let anyone fill the log.
    console.warn('refused cross-origin', key, 'origin=' + origin, 'expected=' + cfg.ORIGIN);
    return Response.json({ error: 'cross-origin request refused' }, { status: 403 });
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BODY) return Response.json({ error: 'body too large' }, { status: 413 });
    try { req._body = text ? JSON.parse(text) : {}; }
    catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  }

  try {
    await handler(req, res, c);
  } catch (e) {
    console.error(key, e);
    if (!res.headersSent) return Response.json({ error: 'server error' }, { status: 500 });
  }
  return res.toResponse();
}

/* ---------- entry points ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handle(request, env, ctx);
    // Everything else is the built frontend. run_worker_first in wrangler.jsonc means only /api/*
    // reaches this Worker at all, so this is a belt-and-braces fallback.
    return env.ASSETS.fetch(request);
  },

  // Upstream scans every user every 10 seconds. A Cron Trigger fires at most once a minute, so a
  // reminder can land up to ~60s after its target minute instead of ~9s. Only users whose reminder
  // is on and whose minute matches cost a state read; the rest are settled from the users row.
  async scheduled(event, env, ctx) {
    const cfg = config(env);
    const store = new Store(env.DB);

    for (const user of await store.listUsers()) {
      try {
        if (!user.reminder?.on || user.disabled) continue;
        const now = userNow(user.reminder.tz || 'UTC');
        if (!now || user.reminder.time !== now.hhmm) continue;
        if (user.lastReminder === now.date) continue;
        if (!(await store.hasPush(user.id))) continue;

        const S = await store.readState(user.id);
        if (!S) continue;
        if ((S.workouts || []).some(w => w.d === now.date)) continue;
        const rid = effectiveRoutineId(S, now.date);
        if (!rid) continue;                                  // rest day — nothing planned
        const routine = (S.routines || []).find(r => r.id === rid);

        // Marked before sending: a push that fails is better than one that repeats every minute
        // for the rest of the hour.
        await store.updateUser(user.id, { lastReminder: now.date });
        await sendPush(store, cfg, user.id, dayReminderPush(S.lang, routine));
      } catch (e) {
        console.error('reminder failed for', user.id, e.message);
      }
    }

    // Housekeeping that upstream does on its own intervals.
    await store.sweepPresence(PRESENCE_TTL);
    await store.sweepExpired();
    if (new Date().getUTCMinutes() === 0 && cfg.AUDIT_ON) {
      await store.compactAudit(cfg.AUDIT_MAX, cfg.AUDIT_DAYS);
    }
  }
};
