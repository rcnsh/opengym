/* Rest-timer alarm, one Durable Object per user.

   api/server.js keeps a Map<userId, Timeout> and a setTimeout of up to an hour. Nothing in a
   Worker survives the response that created it, so the deadline has to be handed to something
   that does — a Durable Object alarm is the only such thing on this platform.

   The client schedules on start/extend and cancels on skip or on-screen completion, so this only
   ever fires when the tab was backgrounded or suspended and never got to cancel it itself.
   Keyed by userId (idFromName), which gives the same one-timer-per-user replacement semantics as
   upstream's Map: scheduling again simply overwrites the pending alarm. */

import { DurableObject } from 'cloudflare:workers';
import { Store } from './store.js';
import { config, sendPush } from './runtime.js';
import { restTimerPush } from '../../api/push-messages.js';

export class RestTimer extends DurableObject {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/schedule') {
      const { userId, seconds, lang } = await request.json();
      await this.ctx.storage.put('job', { userId, lang: lang || null });
      // setAlarm replaces any alarm already pending on this object, so an extended rest period
      // does not need an explicit cancel first.
      await this.ctx.storage.setAlarm(Date.now() + seconds * 1000);
      return Response.json({ ok: true });
    }

    if (pathname === '/cancel') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete('job');
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const job = await this.ctx.storage.get('job');
    // Cleared first: an alarm that throws is retried by the platform, and a rest-timer alert is
    // worthless by the time a retry lands. Better to drop it than to buzz someone mid-set later.
    await this.ctx.storage.delete('job');
    if (!job?.userId) return;
    await sendPush(new Store(this.env.DB), config(this.env), job.userId, restTimerPush(job.lang));
  }
}
