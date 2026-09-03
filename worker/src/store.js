/* D1 store — the layer api/server.js's fs calls map onto.
   Upstream holds db.json wholly in memory and rewrites it on every change; that works for a
   single long-lived process and not at all for a Worker, so each entity gets its own statement.
   Everything here returns the same object shapes the upstream handlers already expect. */

// D1 caps a row at 2 MB and a SQL statement at 100 KB. 64 KB stays clear of both even if bound
// parameters are counted toward statement length, at the cost of more rows per sync.
const CHUNK = 64 * 1024;

const nowIso = () => new Date().toISOString();

export class Store {
  constructor(db) { this.db = db; }

  /* ---------- users ---------- */

  async getUser(id) {
    if (!id) return null;
    return rowToUser(await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first());
  }

  async listUsers() {
    const { results } = await this.db.prepare('SELECT * FROM users ORDER BY created').all();
    return results.map(rowToUser);
  }

  async insertUser(user) {
    await this.db.prepare(
      'INSERT INTO users (id, name, created, invited_by) VALUES (?, ?, ?, ?)'
    ).bind(user.id, user.name, user.created, user.invitedBy || null).run();
  }

  // Only the columns upstream actually mutates on a user object.
  async updateUser(id, fields) {
    const map = {
      sv: 'sv', disabled: 'disabled', admin: 'admin',
      lastReminder: 'last_reminder', name: 'name'
    };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!map[k]) continue;
      sets.push(map[k] + ' = ?');
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    vals.push(id);
    await this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  }

  /* ---------- credentials ---------- */

  async getCred(id) {
    if (!id) return null;
    const r = await this.db.prepare('SELECT * FROM creds WHERE id = ?').bind(id).first();
    if (!r) return null;
    return {
      id: r.id, userId: r.user_id, publicKey: r.public_key,
      counter: r.counter, transports: safeJson(r.transports, [])
    };
  }

  async insertCred(cred) {
    await this.db.prepare(
      'INSERT INTO creds (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)'
    ).bind(cred.id, cred.userId, cred.publicKey, cred.counter || 0,
           JSON.stringify(cred.transports || [])).run();
  }

  async setCredCounter(id, counter) {
    await this.db.prepare('UPDATE creds SET counter = ? WHERE id = ?').bind(counter, id).run();
  }

  /* ---------- push subscriptions ---------- */

  async listSubs(userId) {
    const { results } = await this.db.prepare(
      'SELECT * FROM subs WHERE user_id = ? ORDER BY created'
    ).bind(userId).all();
    return results.map(r => ({
      userId: r.user_id, endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth }, created: r.created
    }));
  }

  async hasPush(userId) {
    const r = await this.db.prepare('SELECT 1 FROM subs WHERE user_id = ? LIMIT 1').bind(userId).first();
    return !!r;
  }

  // Upstream replaces any existing row for the endpoint, then trims the user back under the cap.
  async putSub(userId, endpoint, keys, max) {
    await this.db.batch([
      this.db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(endpoint),
      this.db.prepare(
        'INSERT INTO subs (endpoint, user_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)'
      ).bind(endpoint, userId, keys.p256dh, keys.auth, nowIso())
    ]);
    await this.db.prepare(
      `DELETE FROM subs WHERE user_id = ?1 AND endpoint NOT IN
         (SELECT endpoint FROM subs WHERE user_id = ?1 ORDER BY created DESC LIMIT ?2)`
    ).bind(userId, max).run();
  }

  async removeSub(userId, endpoint) {
    await this.db.prepare('DELETE FROM subs WHERE user_id = ? AND endpoint = ?')
      .bind(userId, endpoint).run();
  }

  // Used when a push endpoint reports 404/410 — the subscription is gone for good.
  async removeSubByEndpoint(endpoint) {
    await this.db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(endpoint).run();
  }

  /* ---------- invites ---------- */

  async findUsableInvite(code) {
    if (!code) return null;
    return await this.db.prepare(
      'SELECT * FROM invites WHERE code = ? AND used_by IS NULL AND revoked = 0'
    ).bind(code).first();
  }

  async listInvites() {
    const { results } = await this.db.prepare(
      `SELECT i.*, u.name AS used_by_name FROM invites i
         LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created`
    ).all();
    return results.map(r => ({
      code: r.code, note: r.note, created: r.created, createdBy: r.created_by,
      usedBy: r.used_by, usedAt: r.used_at, usedByName: r.used_by_name || null,
      revoked: !!r.revoked
    }));
  }

  async insertInvite(inv) {
    await this.db.prepare(
      'INSERT INTO invites (code, note, created, created_by) VALUES (?, ?, ?, ?)'
    ).bind(inv.code, inv.note || '', inv.created, inv.createdBy || null).run();
  }

  async inviteExists(code) {
    return !!(await this.db.prepare('SELECT 1 FROM invites WHERE code = ?').bind(code).first());
  }

  async getInvite(code) {
    return await this.db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();
  }

  async burnInvite(code, userId, usedAt) {
    await this.db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?')
      .bind(userId, usedAt, code).run();
  }

  async dropInvite(code) {
    await this.db.prepare('DELETE FROM invites WHERE code = ?').bind(code).run();
  }

  /* ---------- per-user state (state-<uid>.json) ---------- */

  async readState(userId) {
    const { results } = await this.db.prepare(
      'SELECT body FROM state_chunks WHERE user_id = ? ORDER BY seq'
    ).bind(userId).all();
    if (!results.length) return null;
    return safeJson(results.map(r => r.body).join(''), null);
  }

  async writeState(userId, state) {
    const text = JSON.stringify(state);
    const stmts = [this.db.prepare('DELETE FROM state_chunks WHERE user_id = ?').bind(userId)];
    for (let i = 0, seq = 0; i < text.length; i += CHUNK, seq++) {
      stmts.push(this.db.prepare(
        'INSERT INTO state_chunks (user_id, seq, body) VALUES (?, ?, ?)'
      ).bind(userId, seq, text.slice(i, i + CHUNK)));
    }
    // Denormalise the fields the reminder cron and the admin list would otherwise read a whole
    // state blob to get. Kept in the same batch so they can never disagree with the stored state.
    const workouts = Array.isArray(state.workouts) ? state.workouts : [];
    const last = workouts[workouts.length - 1];
    const rem = state.reminder || {};
    stmts.push(this.db.prepare(
      `UPDATE users SET reminder_on = ?, reminder_time = ?, reminder_tz = ?, lang = ?,
                        last_sync = ?, workouts = ?, last_workout = ? WHERE id = ?`
    ).bind(
      rem.on ? 1 : 0, rem.time || null, rem.tz || null, state.lang || null,
      state._ts || null, workouts.length, last ? last.d : null, userId
    ));
    await this.db.batch(stmts);
  }

  /* ---------- challenges and pairing codes ---------- */

  // Both are one-shot with a 5-minute TTL. Upstream sweeps them on a timer; a Worker has no timer
  // to sweep from, so each read drops what it took and clears anything else already expired.
  async putChallenge(cid, data, exp) {
    await this.db.prepare('INSERT INTO challenges (cid, data, exp) VALUES (?, ?, ?)')
      .bind(cid, JSON.stringify(data), exp).run();
  }

  async takeChallenge(cid) {
    if (!cid) return null;
    const now = Date.now();
    const r = await this.db.prepare('SELECT * FROM challenges WHERE cid = ?').bind(cid).first();
    await this.db.batch([
      this.db.prepare('DELETE FROM challenges WHERE cid = ?').bind(cid),
      this.db.prepare('DELETE FROM challenges WHERE exp < ?').bind(now)
    ]);
    if (!r || r.exp < now) return null;
    return safeJson(r.data, null);
  }

  async putPairing(code, uid, exp) {
    await this.db.prepare('INSERT INTO pairings (code, uid, exp) VALUES (?, ?, ?)')
      .bind(code, uid, exp).run();
  }

  async takePairing(code) {
    if (!code) return null;
    const now = Date.now();
    const r = await this.db.prepare('SELECT * FROM pairings WHERE code = ?').bind(code).first();
    await this.db.batch([
      this.db.prepare('DELETE FROM pairings WHERE code = ?').bind(code),
      this.db.prepare('DELETE FROM pairings WHERE exp < ?').bind(now)
    ]);
    if (!r || r.exp < now) return null;
    return { uid: r.uid, exp: r.exp };
  }

  async pairingExists(code) {
    return !!(await this.db.prepare('SELECT 1 FROM pairings WHERE code = ?').bind(code).first());
  }

  /* ---------- live presence ---------- */

  // Expired rows are filtered on read rather than swept on a timer, so a stale heartbeat can
  // never show someone as training; the delete below is only housekeeping.
  async setPresence(userId, p) {
    await this.db.prepare(
      `INSERT INTO presence (user_id, name, ex_idx, ex_total, sets_done, sets_total, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         name = excluded.name, ex_idx = excluded.ex_idx, ex_total = excluded.ex_total,
         sets_done = excluded.sets_done, sets_total = excluded.sets_total,
         started_at = excluded.started_at, updated_at = excluded.updated_at`
    ).bind(userId, p.name, p.exIdx, p.exTotal, p.setsDone, p.setsTotal, p.startedAt, p.updatedAt).run();
  }

  async clearPresence(userId) {
    await this.db.prepare('DELETE FROM presence WHERE user_id = ?').bind(userId).run();
  }

  async livePresence(ttl) {
    const cutoff = Date.now() - ttl;
    const { results } = await this.db.prepare('SELECT * FROM presence WHERE updated_at >= ?')
      .bind(cutoff).all();
    const map = new Map();
    for (const r of results) {
      map.set(r.user_id, {
        name: r.name, exIdx: r.ex_idx, exTotal: r.ex_total,
        setsDone: r.sets_done, setsTotal: r.sets_total,
        startedAt: r.started_at, updatedAt: r.updated_at
      });
    }
    return map;
  }

  async sweepPresence(ttl) {
    await this.db.prepare('DELETE FROM presence WHERE updated_at < ?').bind(Date.now() - ttl).run();
  }

  /* ---------- audit log ---------- */

  async audit(rec) {
    await this.db.prepare(
      'INSERT INTO audit (ts, ev, ok, uid, name, tgt, tname, msg, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(rec.ts, rec.ev, rec.ok ? 1 : 0, rec.uid || null, rec.name || null,
           rec.tgt || null, rec.tname || null, rec.msg || null, rec.ip || null).run();
  }

  // Retention is a cap, not an archive: age first, then the newest AUDIT_MAX of what is left.
  async compactAudit(max, days) {
    const stmts = [];
    if (days) {
      stmts.push(this.db.prepare('DELETE FROM audit WHERE ts < ?')
        .bind(Date.now() - days * 86400000));
    }
    if (max) {
      stmts.push(this.db.prepare(
        'DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)'
      ).bind(max));
    }
    if (stmts.length) await this.db.batch(stmts);
  }

  async auditPage({ limit, before, cat }) {
    const where = ['id < ?'], vals = [Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER];
    if (cat === 'fail') where.push('ok = 0');
    else if (cat) { where.push('ev LIKE ?'); vals.push(cat + '.%'); }
    const clause = where.join(' AND ');

    const countWhere = where.slice(1).join(' AND ') || '1';
    const countVals = vals.slice(1);
    const total = await this.db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE ${countWhere}`)
      .bind(...countVals).first();

    const { results } = await this.db.prepare(
      `SELECT * FROM audit WHERE ${clause} ORDER BY id DESC LIMIT ?`
    ).bind(...vals, limit).all();

    return {
      events: results.map(r => {
        const e = { id: r.id, ts: r.ts, ev: r.ev, ok: !!r.ok };
        for (const k of ['uid', 'name', 'tgt', 'tname', 'msg', 'ip']) if (r[k] != null) e[k] = r[k];
        return e;
      }),
      total: total?.n || 0
    };
  }

  // Upstream unlinks the file but never resets its sequence, so the gap in ids stays visible.
  // AUTOINCREMENT gives the same property here: sqlite_sequence is deliberately left alone.
  async clearAudit() {
    await this.db.prepare('DELETE FROM audit').run();
  }
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, created: r.created,
    sv: r.sv, admin: !!r.admin, disabled: !!r.disabled,
    invitedBy: r.invited_by, lastReminder: r.last_reminder,
    reminder: { on: !!r.reminder_on, time: r.reminder_time, tz: r.reminder_tz },
    lang: r.lang, lastSync: r.last_sync,
    workouts: r.workouts, lastWorkout: r.last_workout
  };
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}
