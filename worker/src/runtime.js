/* Shared between the Worker entry (index.js) and the rest-timer Durable Object (user-do.js).
   Both need the env-derived config and the ability to send a push, and neither can import the
   other without a cycle, so the two live here. */

import webpush from 'web-push';

// Upstream reads process.env once at module scope. Workers hand env to each invocation instead,
// so this is rebuilt per call; it is cheap and keeps the defaults in one place.
export function config(env) {
  const ORIGIN = (env.ORIGIN || 'http://localhost:8787').replace(/\/+$/, '');
  const SECURE = /^https:/i.test(ORIGIN);
  const auditMax = env.AUDIT_MAX === undefined ? 5000 : +env.AUDIT_MAX;
  const auditDays = +(env.AUDIT_DAYS || 0);
  return {
    RP_ID: env.RP_ID || 'localhost',
    ORIGIN,
    RP_NAME: env.RP_NAME || 'openGym',
    ADMIN_UIDS: String(env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean),
    INVITE_ONLY: /^(1|true|yes|on)$/i.test(env.INVITE_ONLY || ''),
    // Polarity is inverted from INVITE_ONLY on purpose: the safe default here is the permissive one.
    ALLOW_GUEST: !/^(0|false|no|off)$/i.test(env.ALLOW_GUEST || ''),
    SESSION_DAYS: Math.max(1, +(env.SESSION_DAYS || 90) || 90),
    SECURE,
    // The __Host- prefix makes the browser guarantee the cookie is host-only, which is what stops
    // a sibling subdomain planting a shadowing session cookie. It requires Secure, so over plain
    // http://localhost the old name stays. Both are accepted on the way in.
    COOKIE: SECURE ? '__Host-gymsid' : 'gymsid',
    LEGACY_COOKIE: 'gymsid',
    SECRET: env.SESSION_SECRET || '',
    VAPID_PUBLIC: env.VAPID_PUBLIC_KEY || '',
    VAPID_PRIVATE: env.VAPID_PRIVATE_KEY || '',
    VAPID_SUBJECT: env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost'),
    AUDIT_ON: !/^(0|false|no|off)$/i.test(env.AUDIT_LOG || ''),
    AUDIT_MAX: Number.isFinite(auditMax) ? auditMax : 5000,
    AUDIT_DAYS: Number.isFinite(auditDays) ? auditDays : 0,
    AUDIT_IP: ['off', 'net', 'full'].includes(env.AUDIT_IP) ? env.AUDIT_IP : 'net'
  };
}

// web-push is used only for its crypto: generateRequestDetails() does the VAPID JWT and the
// RFC 8291 payload encryption and hands back a plain request, which fetch sends. sendNotification()
// would pull in node:https, which is the one part of that library not worth relying on here.
export async function sendPush(store, cfg, userId, payload) {
  if (!cfg.VAPID_PUBLIC || !cfg.VAPID_PRIVATE) return;
  const subs = await store.listSubs(userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subs.map(async s => {
    try {
      const d = webpush.generateRequestDetails(
        { endpoint: s.endpoint, keys: s.keys }, body,
        {
          vapidDetails: {
            subject: cfg.VAPID_SUBJECT,
            publicKey: cfg.VAPID_PUBLIC,
            privateKey: cfg.VAPID_PRIVATE
          },
          contentEncoding: 'aes128gcm', TTL: 3600
        }
      );
      const r = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body });
      // 404/410 mean the browser threw the subscription away; anything else may be transient.
      if (r.status === 404 || r.status === 410) dead.push(s.endpoint);
    } catch (e) {
      console.error('push failed', s.endpoint.slice(0, 40), e.message);
    }
  }));
  for (const endpoint of dead) await store.removeSubByEndpoint(endpoint);
}
