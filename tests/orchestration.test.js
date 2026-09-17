'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process'); const { promisify } = require('util');
const exec = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-modes-'));
process.env.HH_CONFIG_DIR = path.join(tmp, 'config'); process.env.HH_STATE_DIR = path.join(tmp, 'state');
process.env.HH_UPSTREAM_KEY = 'private-provider-key'; process.env.GH_TOKEN = 'keep-tool-credential';
const config = require('../lib/config'); const api = require('../lib/api'); const policy = require('../lib/orchestration');
const { fixture, configuration } = require('./native-fixture');
const hh = path.resolve(__dirname, '../bin/hh');
test('dual mode launch and configuration contracts', async t => {
  const f = await fixture(); t.after(async () => { await f.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const c = configuration(f.url); c.gateways.chat.secret = 'env:HH_UPSTREAM_KEY';
  const capture = path.join(tmp, 'capture');
  fs.writeFileSync(capture, `#!/usr/bin/env node
const a=process.argv.slice(2);let u=process.env.ANTHROPIC_BASE_URL;let key=process.env.ANTHROPIC_AUTH_TOKEN;
for(let i=0;i<a.length;i++)if(a[i]==='-c'&&a[i+1].startsWith('model_providers.hh.base_url=')){u=a[i+1].split('=').slice(1).join('=').replace(/\\/v1$/,'');key=process.env.HH_CODEX_KEY;}
(async()=>{const r=await fetch(u+'/health',{headers:{authorization:'Bearer '+key}});console.log(JSON.stringify({argv:a,url:u,health:await r.json(),upstreamPresent:!!process.env.HH_UPSTREAM_KEY,toolCredential:process.env.GH_TOKEN==='keep-tool-credential'}));})().catch(()=>process.exit(1));
`, { mode: 0o755 });
  c.profiles.native.bin = capture;
  c.profiles.claude = { ...c.profiles.native, agent: 'claude' };
  c.profiles.direct = { agent: 'codex', model: 'direct-model' };
  config.save(c);
  const call = args => exec(process.execPath, [hh, ...args], { env: process.env, timeout: 20000 });
  await t.test('external mode keeps official authentication and Codex Leader support', () => {
    const p = api.launchPlan('direct', [], { leader: true }); assert.equal(p.mode, 'external'); assert.equal(p.native, null);
    assert(p.argv.some(a => a.startsWith('developer_instructions='))); assert.equal(p.env.HH_UPSTREAM_KEY, process.env.HH_UPSTREAM_KEY);
  });
  await t.test('native plan is offline and reuses gateway definitions', async () => {
    const before = f.requests.length; const { stdout } = await call(['native', 'plan', 'native']); const p = JSON.parse(stdout);
    assert.equal(p.runtime, 'builtin'); assert.equal(p.main, 'chat/primary'); assert.equal(f.requests.length, before); assert(!stdout.includes('private-provider-key'));
    assert(!fs.existsSync(p.catalog));
  });
  await t.test('dry run starts no service and produces scoped routing flags', async () => {
    const { stdout } = await call(['run', 'native', '--dry-run']); const p = JSON.parse(stdout);
    assert.equal(p.mode, 'native'); assert(p.argv.some(a => a.includes('127.0.0.1:0'))); assert(!stdout.includes('private-provider-key'));
  });
  for (const profile of ['native', 'claude']) await t.test(`${profile}: owned server starts, credentials isolated, exit cleans resources`, async () => {
    const { stdout } = await call(['run', profile, '--no-herdr']); const result = JSON.parse(stdout.trim().split('\n')[0]);
    assert.equal(result.health.service, 'herdr-hybrid'); assert(result.health.ready); assert.equal(result.upstreamPresent, false); assert.equal(result.toolCredential, true);
    await assert.rejects(fetch(result.url + '/health'));
    if (profile === 'native') {
      assert(result.argv.some(a => a.startsWith('agents.default_subagent_model="hh/worker-')));
      const catalog = JSON.parse(result.argv.find(a => a.startsWith('model_catalog_json=')).slice('model_catalog_json='.length)); assert(!fs.existsSync(catalog));
    } else {
      const defs = JSON.parse(result.argv[result.argv.indexOf('--agents') + 1]); assert(defs['hh-worker'].prompt.includes('hh-route: hh/worker-')); assert.equal(defs['hh-worker'].model, 'haiku');
    }
  });
  await t.test('mode switch preserves native policy without changing external transport', async () => {
    await call(['mode', 'native', '--mode', 'external']); assert.equal(config.load().profiles.native.orchestration.mode, 'external');
    const p = api.launchPlan('native', [], { leader: true }); assert.equal(p.native, null); assert(p.resolved.args.includes(`model_providers.hh.base_url=${f.url}`));
    await call(['mode', 'native', '--mode', 'native', '--fallback', '']); assert.deepEqual(config.load().profiles.native.orchestration.fallback, []);
  });
  await t.test('gateway protocol metadata is configured once and secrets remain masked', async () => {
    const { stdout } = await call(['gateways', 'set', 'chat', '--wire', 'chat', '--context-window', '64000', '--max-output-tokens', '4096']);
    assert.equal(JSON.parse(stdout).gateway.wire, 'chat'); assert(!stdout.includes('private-provider-key')); assert.equal(config.load().gateways.chat.contextWindow, 64000);
  });
  await t.test('missing protocol and gateway fail before creating a client', () => {
    const broken = config.load(); delete broken.gateways.chat.wire; config.save(broken);
    assert.throws(() => api.launchPlan('native', [], { leader: true }), e => e.code === 'no_wire');
    config.save(c);
    assert.throws(() => api.modeSet('native', { mode: 'native', workerModel: 'wrong' }));
    assert.throws(() => policy.validate({ mode: 'native', workerModel: 'chat/one -->' }));
    assert.throws(() => config.validateGateway('x', { url: f.url, auth: 'token', secret: 'x', wire: 'wrong' }));
  });
  await t.test('previous external integration is not a runtime dependency', async () => {
    await assert.rejects(call(['install', 'opencodex']), e => e.stdout.includes('bad_arg'));
    await assert.rejects(call(['bridge', 'status']));
    assert(!fs.existsSync(path.resolve(__dirname, '../lib/bridge.js')));
    assert(!JSON.stringify(require('../package.json').dependencies || {}).includes('opencodex'));
  });
});
