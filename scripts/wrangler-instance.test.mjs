/* The merge that decides which hostname and which database a deploy lands on. A bug here does
 * not throw — it ships a working Worker pointed at the wrong instance — so it gets a test.
 *
 *   node --test scripts/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonc, merge, stripJsonComments } from './wrangler-instance.mjs';

test('strips line and block comments but not the ones inside strings', () => {
  const src = `{
    // a line comment
    "origin": "https://gym.example.com", /* trailing block */
    "note": "http://x/y // not a comment",
    /* multi
       line */
    "keep": 1,
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(src)), {
    origin: 'https://gym.example.com',
    note: 'http://x/y // not a comment',
    keep: 1,
  });
});

test('keeps an escaped quote from ending the string', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"a": "say \\" // still string"}')),
    { a: 'say " // still string' });
});

test('objects merge key by key, so a var the instance omits keeps its generic value', () => {
  const out = merge({ vars: { RP_ID: 'localhost', RP_NAME: 'openGym' } },
                    { vars: { RP_ID: 'gym.example.com' } });
  assert.deepEqual(out, { vars: { RP_ID: 'gym.example.com', RP_NAME: 'openGym' } });
});

test('arrays replace outright rather than concatenating', () => {
  const out = merge({ d1_databases: [{ binding: 'DB', database_id: 'placeholder' }] },
                    { d1_databases: [{ binding: 'DB', database_id: 'real' }] });
  assert.deepEqual(out.d1_databases, [{ binding: 'DB', database_id: 'real' }]);
});

test('a key the generic config does not have is added', () => {
  assert.deepEqual(merge({ name: 'opengym' }, { routes: [{ pattern: 'gym.example.com' }] }),
    { name: 'opengym', routes: [{ pattern: 'gym.example.com' }] });
});

test('the two real config files merge into a deployable instance config', () => {
  const merged = merge(readJsonc('wrangler.jsonc'), readJsonc('instance.jsonc'));

  // The three things the generic config cannot know, and the reason this file exists.
  assert.equal(merged.vars.RP_ID, merged.routes[0].pattern);
  assert.equal(merged.vars.ORIGIN, `https://${merged.vars.RP_ID}`);
  assert.notEqual(merged.d1_databases[0].database_id,
    '00000000-0000-0000-0000-000000000000', 'instance.jsonc must name a real database');

  // Inherited from wrangler.jsonc, and easy to lose to a sloppier merge.
  assert.equal(merged.main, './worker/src/index.js');
  assert.equal(merged.assets.directory, './frontend/dist/');
  assert.equal(merged.d1_databases[0].migrations_dir, './worker/migrations');
  assert.deepEqual(merged.durable_objects.bindings, [{ name: 'REST_TIMER', class_name: 'RestTimer' }]);

  // A secret that reached vars would be published in the repo.
  for (const k of ['SESSION_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'ADMIN_UIDS']) {
    assert.ok(!(k in merged.vars), `${k} belongs in \`wrangler secret put\`, not vars`);
  }
});
