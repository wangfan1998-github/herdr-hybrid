'use strict';
// Optional real CLI config validation: starts no task and sends no model requests.
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const readline = require('readline');
const adapter = require('../lib/agents/codex');
const child = spawn('codex', ['app-server', '--strict-config', ...adapter.leaderArgs('hh compatibility verification'), '-c', 'agents.default_subagent_model="vendor/fast"', '-c', 'agents.default_subagent_reasoning_effort="high"', '-c', 'features.multi_agent=true', '-c', 'features.multi_agent_v2=false'], { stdio: ['pipe', 'pipe', 'pipe'] });
let verified = false;
const timer = setTimeout(() => { console.error('Codex config validation timed out'); process.exitCode = 1; child.kill(); }, 15000);
child.stderr.resume();
child.on('error', () => { clearTimeout(timer); console.error('Codex CLI could not start'); process.exitCode = 1; });
child.on('exit', () => { clearTimeout(timer); if (!verified) process.exitCode = 1; });
const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
readline.createInterface({ input: child.stdout }).on('line', line => {
  let obj; try { obj = JSON.parse(line); } catch { return; }
  if (obj.id === 1 && !obj.error) { send({ method: 'initialized' }); send({ method: 'config/read', id: 2, params: { includeLayers: false } }); }
  if (obj.id !== 2) return;
  try {
    assert(!obj.error);
    const cfg = obj.result.config;
    assert.equal(cfg.developer_instructions, 'hh compatibility verification');
    assert.equal(cfg.agents.default_subagent_model, 'vendor/fast');
    assert.equal(cfg.agents.default_subagent_reasoning_effort, 'high');
    verified = true; console.log('PASS real Codex strict config: Leader instructions, worker model and effort');
  } catch { console.error('Codex rejected or ignored required configuration'); process.exitCode = 1; }
  finally { clearTimeout(timer); child.kill(); }
});
send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'hh-compat', version: '1' } } });
