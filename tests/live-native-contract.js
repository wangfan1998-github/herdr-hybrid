'use strict';
// Real Codex / Claude Code -> hh internal router -> local mock providers.
// Requires installed CLI binaries; no outside model requests or model credentials.
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-live-native-'));
process.env.HH_CONFIG_DIR = path.join(tmp, 'config'); process.env.HH_STATE_DIR = path.join(tmp, 'state');
const config = require('../lib/config'); const api = require('../lib/api'); const native = require('../lib/native');
const { fixture, configuration } = require('./native-fixture');
async function main() {
  const watchdog = setTimeout(() => { console.error('live native contract timed out'); process.exit(1); }, 110000);
  const f = await fixture();
  try {
    for (const agent of process.argv[2] ? [process.argv[2]] : ['claude', 'codex']) {
      const c = configuration(f.url); c.profiles.native.agent = agent;
      c.profiles.native.orchestration.fallback = []; c.profiles.native.orchestration.models = [];
      c.profiles.native.env = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      config.save(c); f.state.mode = 'delegate'; f.state.delegated = false;
      const before = f.requests.length; const session = await native.start(c, 'native');
      try {
        const args = agent === 'claude' ? ['-p', 'Use hh-worker to reply pong, then report its answer.', '--tools', 'Agent', '--allowedTools', 'Agent', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--setting-sources', ''] : ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', 'Spawn a worker using anthropic/worker to reply pong, then report.'];
        const p = api.launchPlan('native', args, { leader: true, nativeRuntime: session });
        delete p.env.CLAUDECODE; delete p.env.CLAUDE_CODE_SIMPLE;
        const result = await new Promise((resolve, reject) => {
          const child = spawn(agent, p.argv, { cwd: tmp, env: p.env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = ''; let stderr = '';
          child.stdout.on('data', b => { stdout = (stdout + b).slice(-20000); }); child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
          const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
          child.once('error', e => { clearTimeout(timer); reject(e); });
          child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        });
        const requests = f.requests.slice(before);
        console.log(JSON.stringify({ agent, exit: result.code, calls: requests.length, models: requests.map(r => r.body.model), delegationRequested: f.state.delegated }));
        if (result.code !== 0 || !requests.some(r => r.body.model === 'worker')) {
          // Only isolated fixture process output; never print real request bodies or credentials.
          console.error(result.stdout.slice(-3500)); console.error(result.stderr.slice(-2500));
        }
        assert.equal(result.code, 0, `${agent} exited unsuccessfully`);
        assert(requests.some(r => r.body.model === 'worker'), `${agent} did not actually invoke the different worker provider`);
        assert(requests.some(r => r.path === '/v1/chat/completions' && r.body.model === 'primary'));
        assert(requests.some(r => r.path === '/v1/messages' && r.body.model === 'worker'));
      } finally { await session.close(); }
    }
  } finally { await f.close(); clearTimeout(watchdog); fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
