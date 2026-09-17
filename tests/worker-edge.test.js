'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-worker-edge-'));
process.env.HH_CONFIG_DIR = path.join(tmp, 'config');
process.env.HH_STATE_DIR = path.join(tmp, 'state');
const config = require('../lib/config');
const runs = require('../lib/runs');
const { writeJson, sleep } = require('../lib/util');
const hh = path.resolve(__dirname, '../bin/hh');
const fake = path.join(tmp, 'fake');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.HH_RUN_DIR + '/effects', 'launch\\n');
require(${JSON.stringify(path.resolve(__dirname, 'fake-agent'))});
`, { mode: 0o755 });
let count = 0;
function cfg(agent = 'claude') {
  return { version: 2, viewer: 'none', profiles: { edge: { agent, bin: fake } }, gateways: {}, roles: {}, commonEnv: {} };
}
function seed(extra = {}) {
  const id = `edge-${++count}`;
  fs.mkdirSync(runs.runDir(id), { recursive: true });
  writeJson(path.join(runs.runDir(id), 'meta.json'), {
    id, label: id, profile: 'edge', agent: 'claude', cwd: tmp, created: new Date().toISOString(),
    status: 'starting', worker_pid: null, child_pid: null, autonomy: 'full', ...extra,
  });
  fs.writeFileSync(path.join(runs.runDir(id), 'task.md'), 'do work');
  return id;
}
function worker(id, env = {}) {
  return exec(process.execPath, [hh, '_worker', id], { env: { ...process.env, ...env }, timeout: 15000 });
}
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) { assert(Date.now() < deadline, 'timed out waiting for worker'); await sleep(10); }
}
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('cancel before delayed worker start prevents all agent side effects and preserves result', async () => {
  config.save(cfg());
  const id = seed();
  assert.equal((await runs.cancelRun(id)).status, 'cancelled');
  const result = runs.readResult(id);
  // Even invalid configuration must not be read by the delayed cancelled worker.
  fs.writeFileSync(config.CONFIG_FILE, 'invalid');
  await worker(id);
  assert.deepEqual(runs.readResult(id), result);
  assert.equal(runs.readMeta(id).status, 'cancelled');
  assert(!fs.existsSync(path.join(runs.runDir(id), 'effects')));
  assert(!fs.existsSync(path.join(runs.runDir(id), 'worker.claim')));
});

test('concurrent and repeated worker launches execute the agent exactly once', async () => {
  config.save(cfg());
  const id = seed();
  await Promise.all([worker(id, { FAKE_SLEEP: '0.2' }), worker(id, { FAKE_SLEEP: '0.2' })]);
  await worker(id);
  assert.equal(fs.readFileSync(path.join(runs.runDir(id), 'effects'), 'utf8'), 'launch\n');
  assert.equal(runs.status(id).status, 'done');
});

test('cancellation serializes with startup before child PID publication', async () => {
  config.save(cfg());
  const id = seed();
  const preload = path.join(tmp, 'preload.js');
  fs.writeFileSync(preload, `const cp=require('child_process');const spawn=cp.spawn;cp.spawn=function(...args){require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'startup'))},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);return spawn(...args);};`);
  const pending = worker(id, { NODE_OPTIONS: `--require=${preload}`, FAKE_SLEEP: '10' });
  await until(() => fs.existsSync(path.join(tmp, 'startup')));
  assert.equal((await runs.cancelRun(id)).status, 'cancelled');
  await pending;
  assert.equal(runs.readResult(id).status, 'cancelled');
  assert.equal(runs.readMeta(id).status, 'cancelled');
  await worker(id);
  const effects = path.join(runs.runDir(id), 'effects');
  assert(!fs.existsSync(effects) || fs.readFileSync(effects, 'utf8') === 'launch\n');
});

test('followup rejects a changed agent without creating another run', async () => {
  config.save(cfg());
  const id = seed();
  await worker(id);
  const ids = runs.listIds();
  assert.throws(() => runs.sendFollowup(cfg('codex'), id, 'continue'), e => e.code === 'incompatible_resume');
  assert.deepEqual(runs.listIds(), ids);
});

test('same agent and legacy default agent followups retain their session', async () => {
  config.save(cfg());
  const id = seed({ agent: undefined });
  await worker(id);
  const session = runs.readResult(id).session_id;
  const next = runs.sendFollowup(cfg(), id, 'continue', { view: 'none' });
  assert.equal(runs.readMeta(next.id).resume, session);
  await until(() => runs.readResult(next.id));
  assert.equal(runs.readResult(next.id).status, 'done');
  assert.equal(runs.readResult(next.id).session_id, session);
});

test('profile agent change after dispatch fails before executing a stale resume', async () => {
  config.save(cfg('codex'));
  const id = seed({ resume: 'old-session' });
  await worker(id);
  assert.equal(runs.readResult(id).status, 'failed');
  assert.match(runs.readResult(id).error, /agent/);
  assert(!fs.existsSync(path.join(runs.runDir(id), 'effects')));
});
