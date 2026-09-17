'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-model-alias-'));
process.env.HH_STATE_DIR = path.join(temp, 'state');
const native = require('../lib/native');
const { fixture, configuration } = require('./native-fixture');
test('Claude context suffix normalization resolves only a declared model', async t => {
  const f = await fixture();
  t.after(async () => { await f.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const c = configuration(f.url);
  c.profiles.native.agent = 'claude';
  c.profiles.native.model = 'primary[1m]';
  c.profiles.native.orchestration = { mode: 'native', workerModel: 'anthropic/worker' };
  const s = await native.start(c, 'native');
  t.after(() => s.close());
  const request = model => fetch(s.url + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': s.token },
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'pong' }] }),
  });
  const response = await request('chat/primary');
  assert.equal(response.status, 200); await response.json();
  assert.equal(f.requests.at(-1).body.model, 'primary[1m]');
  const count = f.requests.length;
  assert.equal((await request('chat/undeclared')).status, 400);
  assert.equal(f.requests.length, count);
});
