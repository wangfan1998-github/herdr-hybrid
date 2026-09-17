'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-integration-'));
process.env.HH_CONFIG_DIR = path.join(tmp, 'config');
process.env.HH_STATE_DIR = path.join(tmp, 'state');
const config = require('../lib/config');
const api = require('../lib/api');
const mcp = require('../lib/mcp');
const native = require('../lib/native');
const { configuration, fixture } = require('./native-fixture');
const hh = path.resolve(__dirname, '../bin/hh');
const reset = () => { const c = configuration('http://127.0.0.1:1'); config.save(c); return c; };
const bytes = () => fs.readFileSync(config.CONFIG_FILE, 'utf8');
test('integration edges use isolated configuration', async t => {
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  await t.test('all retained policy gateway references prevent removal', () => {
    for (const mode of ['native', 'external', 'plain']) for (const field of ['workerModel', 'models', 'fallback']) {
      const c = reset(); c.gateways.retained = { ...c.gateways.chat };
      c.profiles.native.orchestration.mode = mode;
      c.profiles.native.orchestration[field] = field === 'workerModel' ? 'retained/worker' : ['retained/worker'];
      config.save(c); const before = bytes();
      assert.throws(() => api.gatewaysRm('retained'), { code: 'referenced' }); assert.equal(bytes(), before);
    }
  });
  await t.test('policy validation rejects missing routes even in external mode atomically', () => {
    reset(); const before = bytes();
    for (const mode of ['native', 'external']) for (const changes of [
      { workerModel: 'missing/worker' }, { workerModel: 'constructor/worker' }, { models: ['missing/worker'] }, { fallback: ['missing/worker'] },
      { models: 'chat/model' }, { prompt: 42 }, { effort: 'invented' }, { unexpected: true },
    ]) {
      assert.throws(() => api.modeSet('native', { mode, ...changes })); assert.equal(bytes(), before);
    }
  });
  await t.test('role profile switch clears inherited stale override but preserves explicit override', () => {
    reset(); api.rolesSet('custom', { profile: 'native', model: 'old', template: '-' });
    assert.equal(api.rolesSet('custom', { profile: 'official' }).config.model, undefined);
    assert.equal(api.rolesSet('custom', { profile: 'native', model: 'explicit' }).config.model, 'explicit');
    assert.equal(api.rolesSet('custom', { desc: 'keep it' }).config.model, 'explicit');
  });
  await t.test('atomic CLI profile and policy save rejects half-applied changes', () => {
    reset(); const before = bytes();
    assert.throws(() => execFileSync(process.execPath, [hh, 'profiles', 'set', 'native', '--model', 'changed', '--orchestration', JSON.stringify({ mode: 'native', workerModel: 'missing/worker' }), '--json'], { stdio: 'pipe' }));
    assert.equal(bytes(), before);
    execFileSync(process.execPath, [hh, 'profiles', 'set', 'native', '--model', 'changed', '--orchestration', JSON.stringify({ mode: 'native', workerModel: 'chat/worker', fallback: [], prompt: '', effort: '' }), '--json']);
    assert.equal(config.load().profiles.native.model, 'changed');
    assert.deepEqual(config.load().profiles.native.orchestration.fallback, []);
  });
  await t.test('launch consumes session catalog identity, exists while running, cleaned after close', async () => {
    reset(); const runtime = await native.start(config.load(), 'native');
    try {
      const plan = api.launchPlan('native', [], { mode: 'native', nativeRuntime: runtime, herdr: false });
      assert.equal(plan.native, runtime);
      assert(plan.argv.includes('model_catalog_json=' + JSON.stringify(runtime.catalogPath)));
      assert(fs.existsSync(runtime.catalogPath));
      assert.equal(plan.env.HH_CODEX_KEY, runtime.token);
      assert(!JSON.stringify(plan.env).includes('secret-chat'));
    } finally { await runtime.close(); }
    assert(!fs.existsSync(runtime.catalogPath));
  });
  await t.test('native rejects argv overrides from interactive settings, profiles and passthrough', () => {
    for (const agent of ['codex', 'claude']) {
      const args = agent === 'codex' ? [['--config=model_provider="evil"'], ['-cmodel="evil"'], ['-p', 'evil'], ['--model', 'evil'], ['--oss']] : [['--model=evil'], ['--settings', '{"env":{"ANTHROPIC_BASE_URL":"evil"}}'], ['--agents={}'], ['--agent=other']];
      for (const argv of args) for (const source of ['extra', 'profile', 'interactive']) {
        const c = reset(); c.profiles.native.agent = agent;
        if (source === 'profile') c.profiles.native.args = argv;
        if (source === 'interactive') c[agent].interactiveArgs = argv;
        config.save(c);
        assert.throws(() => api.launchPlan('native', source === 'extra' ? argv : [], { mode: 'native' }), { code: 'native_override' });
      }
    }
  });
  await t.test('Claude isolation settings accept safe JSON and reject routing/auth overrides', () => {
    const agent = require('../lib/agents/claude');
    for (const args of [
      ['--settings', '{"disableAllHooks":true}', '--setting-sources', ''],
      ['--settings={"disableAllHooks":true}', '--setting-sources='],
      ['--append-system-prompt', '--model', '-p', 'Explain --settings and --model'],
      ['-p', '--', '--settings'],
    ]) assert.doesNotThrow(() => agent.validateNativeArgs(args));
    for (const settings of [{ env: {} }, { model: 'evil' }, { apiKeyHelper: 'evil' }, { agents: {} }, { disableAllHooks: 'true' }]) {
      assert.throws(() => agent.validateNativeArgs(['--settings', JSON.stringify(settings)]), { code: 'native_override' });
    }
    for (const args of [['--settings', '/tmp/settings.json'], ['--setting-sources=project'], ['-p', 'prompt', '--model=evil']]) assert.throws(() => agent.validateNativeArgs(args), { code: 'native_override' });
  });
  await t.test('Codex config grammar separates safe options, reserved keys and prompt text', () => {
    const agent = require('../lib/agents/codex');
    for (const args of [
      ['-c', 'mcp_servers.test.enabled=false', '--disable', 'apps', '-s', 'read-only'],
      ['--config=sandbox_mode="read-only"', '--disable=web_search'],
      ['-cshell_environment_policy.inherit="none"', '-c', 'developer_instructions="--model"'],
      ['exec', 'Explain --model and -c model_provider', '--json'],
      ['exec', '--', '--model'],
      ['--disable', 'enable_request_compression', '--disable', 'remote_compaction_v2'],
      ['-c', 'features.enable_request_compression=false'],
    ]) assert.doesNotThrow(() => agent.validateNativeArgs(args));
    for (const args of [
      ['-c', '"model_provider"="evil"'], ['--config', "'agents'.default_subagent_model='evil'"],
      ['-c', 'features={multi_agent=false}'], ['-c', 'features."multi_agent"=false'],
      ['--enable=enable_request_compression'], ['--enable', 'remote_compaction_v2'], ['--disable', 'multi_agent'],
      ['exec', 'prompt', '-c', 'model_catalog_json="evil"'], ['-cmodel_providers.hh.base_url="evil"'],
    ]) assert.throws(() => agent.validateNativeArgs(args), { code: 'native_override' });
  });
  await t.test('Codex exec receives provider and strict native feature overrides in its own argument group', () => {
    reset();
    const plan = api.launchPlan('native', ['exec', '--json', '--strict-config', '-c', 'mcp_servers.test.enabled=false', '--disable', 'apps', '--', '--model'], { mode: 'native' });
    assert.equal(plan.argv[0], 'exec');
    assert(plan.argv.includes('model_providers.hh.base_url=http://127.0.0.1:0/v1'));
    for (const value of ['features.enable_request_compression=false', 'features.remote_compaction_v2=false', 'features.multi_agent=true', 'features.multi_agent_v2=false']) {
      assert.equal(plan.argv.filter(a => a === value).length, 1);
      assert.equal(plan.argv[plan.argv.indexOf(value) - 1], '-c');
    }
    assert(!plan.argv.some(a => a.includes('apply_patch')));
    assert.deepEqual(plan.argv.slice(-2), ['--', '--model']);
    const adapter = require('../lib/agents/codex');
    assert.deepEqual(adapter.interactiveArgv({}, [], ['--', 'exec']), ['--', 'exec']);
    assert.deepEqual(adapter.interactiveArgv({ interactiveArgs: ['--no-alt-screen'] }, ['-c', 'model_provider=hh'], ['exec', 'prompt']), ['--no-alt-screen', 'exec', '-c', 'model_provider=hh', 'prompt']);
    assert.deepEqual(adapter.interactiveArgv({}, [], ['-c', 'developer_instructions="exec"', 'hello']), ['-c', 'developer_instructions="exec"', 'hello']);
  });
  await t.test('native clears inherited provider switches without affecting plain launches', () => {
    const c = reset(); c.profiles.native.agent = 'claude'; config.save(c);
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    try {
      assert.equal(api.launchPlan('native', [], { mode: 'native' }).env.CLAUDE_CODE_USE_BEDROCK, undefined);
      assert.equal(api.launchPlan('native', [], { mode: 'plain' }).env.CLAUDE_CODE_USE_BEDROCK, '1');
    } finally { delete process.env.CLAUDE_CODE_USE_BEDROCK; }
    assert.throws(() => api.modeSet('native', { effort: 'ultra' }), { code: 'bad_effort' });
  });
  await t.test('MCP policies validate arguments and share saved CLI state', async () => {
    reset();
    await mcp.callTool('hh_policy_set', { profile: 'native', changes: { mode: 'external', prompt: 'test' } });
    assert.equal((await mcp.callTool('hh_policy', { profile: 'native' })).orchestration.prompt, 'test');
    assert.equal((await mcp.callTool('hh_native_plan', { profile: 'native' })).runtime, 'builtin');
    for (const args of [null, [], { profile: 5 }, { profile: 'native', unknown: true }]) await assert.rejects(mcp.callTool('hh_policy', args), { code: -32602 });
    for (const changes of [{ models: [5] }, { fallback: Array(5).fill('chat/x') }, { effort: 'invalid' }, { prompt: 3 }, { gateway: 'chat' }]) await assert.rejects(mcp.callTool('hh_policy_set', { profile: 'native', changes }), { code: -32602 });
  });
  await t.test('mode defaults retain plain direct launch and explicit session overrides', () => {
    reset();
    assert.equal(api.launchPlan('native', [], {}).mode, 'plain');
    assert.equal(api.launchPlan('native', [], { leader: true }).mode, 'native');
    api.modeSet('native', { mode: 'plain' });
    assert.equal(api.launchPlan('native', [], { leader: true }).leader, false);
    assert.equal(api.launchPlan('native', [], { mode: 'external' }).leader, true);
  });
  await t.test('gateway capabilities are optional and strictly validated', () => {
    reset(); const caps = { imageInput: false, parallelToolCalls: true, reasoningEfforts: ['low', 'high'], reasoningSummaries: false };
    assert.deepEqual(api.gatewaysSet('chat', { capabilities: caps }).gateway.capabilities, caps);
    assert.throws(() => api.modeSet('native', { effort: 'ultra' }), { code: 'bad_effort' });
    api.modeSet('native', { mode: 'external', effort: 'ultra' });
    assert.throws(() => api.launchPlan('native', [], { mode: 'native' }), { code: 'bad_effort' });
    const before = bytes();
    for (const capabilities of [null, [], { imageInput: 'yes' }, { reasoningEfforts: ['invented'] }, { reasoningEfforts: ['low', 'low'] }, { unknown: true }]) {
      assert.throws(() => api.gatewaysSet('chat', { capabilities })); assert.equal(bytes(), before);
    }
  });
  await t.test('real isolated CLI mock contracts and strict Codex feature readback', { skip: !process.env.HH_LIVE_CONTRACT }, async live => {
    const f = await fixture(); live.after(() => f.close());
    // Direct-client mock uses complete wire events (the router fixture deliberately
    // omits some optional fields and assumes query-free upstream URLs).
    const directRequests = [];
    const direct = require('http').createServer(async (req, res) => {
      let data = ''; for await (const part of req) data += part;
      const body = JSON.parse(data || '{}'); directRequests.push({ body, path: req.url });
      const text = 'mock pong'; const model = body.model;
      let events;
      if (req.url.split('?')[0].endsWith('/messages')) {
        events = [
          { type: 'message_start', message: { id: 'msg_direct', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: 'message_stop' },
        ];
      } else {
        const item = { id: 'msg_direct', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        const response = { id: 'resp_direct', object: 'response', model, status: 'completed', output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } };
        events = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
    await new Promise(resolve => direct.listen(0, '127.0.0.1', resolve));
    const directUrl = `http://127.0.0.1:${direct.address().port}`;
    live.after(async () => { direct.closeAllConnections(); await new Promise(resolve => direct.close(resolve)); });
    const home = fs.mkdtempSync(path.join(tmp, 'live-home-'));
    const codexHome = path.join(home, '.codex'); fs.mkdirSync(codexHome);
    const baseEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
    for (const agent of ['claude', 'codex']) for (const mode of ['native', 'external']) await live.test(`${agent} ${mode}`, async () => {
      const c = configuration(mode === 'native' ? f.url : directUrl, mode === 'native' ? 'chat' : agent === 'codex' ? 'responses' : 'anthropic');
      c.profiles.native.agent = agent;
      c.profiles.native.orchestration.fallback = []; c.profiles.native.orchestration.models = [];
      for (const g of Object.values(c.gateways)) g.capabilities = { reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], parallelToolCalls: true };
      config.save(c); f.state.mode = mode === 'native' ? 'delegate' : 'text'; f.state.delegated = false;
      const records = mode === 'native' ? f.requests : directRequests;
      const before = records.length;
      const runtime = mode === 'native' ? await native.start(c, 'native') : undefined;
      try {
        const extra = agent === 'claude'
          ? ['-p', 'Use hh-worker to reply pong, then report.', '--tools', mode === 'native' ? 'Agent' : '', '--allowedTools', 'Agent', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--setting-sources', '']
          : ['exec', '--strict-config', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--disable', 'apps', '--disable', 'web_search', ...(mode === 'external' ? ['--disable', 'enable_request_compression'] : []), 'Spawn a worker using anthropic/worker to reply pong, then report.'];
        const plan = api.launchPlan('native', extra, { mode, nativeRuntime: runtime, herdr: false });
        const env = { ...baseEnv };
        for (const [key, value] of Object.entries(plan.resolved.env)) if (/^(ANTHROPIC_|HH_CODEX_KEY$)/.test(key)) env[key] = value;
        // Do not load the configuration panel in this isolated protocol contract.
        const argv = [...plan.argv]; const plugin = argv.indexOf('--plugin-dir'); if (plugin !== -1) argv.splice(plugin, 2);
        const result = await new Promise((resolve, reject) => {
          const child = spawn(agent, argv, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', b => { stdout = (stdout + b).slice(-12000); }); child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
          const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
          const timer = setTimeout(kill, 45000);
          child.once('error', e => { clearTimeout(timer); kill(); reject(e); });
          child.once('close', code => { clearTimeout(timer); kill(); resolve({ code, stdout, stderr }); });
        });
        assert.equal(result.code, 0, result.stderr + result.stdout);
        const requests = records.slice(before);
        assert(requests.some(r => r.body.model === 'primary'), 'primary request reached mock provider');
        if (mode === 'native') assert(requests.some(r => r.body.model === 'worker' && r.path === '/v1/messages'), 'real child request reached different provider');
        assert(result.stdout.includes('pong'));
      } finally { if (runtime) await runtime.close(); }
    });
    await live.test('Codex strict config reads exact native feature values', async () => {
      const c = configuration(f.url); config.save(c);
      const runtime = await native.start(c, 'native');
      try {
        await new Promise((resolve, reject) => {
          const child = spawn('codex', ['app-server', '--strict-config', ...require('../lib/agents/codex').nativeArgs(runtime)], { cwd: home, env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
          let verified = false; let buffer = '';
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('strict config timed out')); }, 15000);
          const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
          child.stderr.resume(); child.on('error', reject);
          child.stdout.on('data', b => {
            buffer += b;
            let i;
            while ((i = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
              let reply; try { reply = JSON.parse(line); } catch { continue; }
              if (reply.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'config/read', params: { includeLayers: false } }); }
              if (reply.id !== 2) continue;
              try {
                assert(!reply.error);
                const cfg = reply.result.config;
                assert.equal(cfg.features.enable_request_compression, false);
                assert.equal(cfg.features.remote_compaction_v2, false);
                assert.equal(cfg.features.multi_agent, true);
                assert.equal(cfg.features.multi_agent_v2, false);
                assert.equal(cfg.agents.default_subagent_model, runtime.worker);
                verified = true;
              } catch (error) { reject(error); }
              finally { clearTimeout(timer); child.kill(); }
            }
          });
          child.once('close', () => { clearTimeout(timer); verified ? resolve() : reject(new Error('strict config readback failed')); });
          send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hh-regression', version: '1' } } });
        });
      } finally { await runtime.close(); }
    });
  });

});
