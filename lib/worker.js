'use strict';
// hh _worker <id>：用 profile 的 env 拉起 `claude -p`。既可以 detached 后台跑，也可以在 herdr tab 里跑（TTY 时同步打印 transcript）。
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { readText, writeJson, nowIso, fmtDuration, tailLines, truncate } = require('./util');
const config = require('./config');
const claude = require('./claude');
const runs = require('./runs');

function q(s) {
  s = String(s);
  return /^[A-Za-z0-9_./:=+@%-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// worker 汇报契约：最终回复末尾的最后一个 ```json 块 → result.report（解析失败或没有就 null）
function extractReport(final) {
  const blocks = [...String(final).matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try {
    const r = JSON.parse(blocks[blocks.length - 1][1]);
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch (e) { return null; }
}

async function main(id) {
  const cfg = config.load();
  const meta = runs.readMeta(id);
  const resolved = config.resolveProfile(cfg, meta.profile, meta.model);
  const dir = runs.runDir(id);
  const taskText = readText(path.join(dir, 'task.md'));
  const argv = claude.headlessArgv({ model: resolved.model, autonomy: meta.autonomy, resume: meta.resume, args: resolved.args });
  const started = nowIso();
  runs.patchMeta(id, { worker_pid: process.pid, status: 'running', started, command: [resolved.bin].concat(argv) });

  const evFd = fs.openSync(path.join(dir, 'events.jsonl'), 'a');
  const outFd = fs.openSync(path.join(dir, 'output.log'), 'a');
  const errFd = fs.openSync(path.join(dir, 'stderr.log'), 'a');
  let tty = !!process.stdout.isTTY;
  process.stdout.on('error', () => { tty = false; });
  process.stderr.on('error', () => { tty = false; });
  const write = (s) => { fs.writeSync(outFd, `${s}\n`); if (tty) { try { process.stdout.write(`${s}\n`); } catch (e) { tty = false; } } };
  write(`# hh run ${id} · ${meta.role || '-'} → ${meta.profile}${resolved.gatewayName ? ` @ ${resolved.gatewayName}` : ''}${resolved.model ? ` (${resolved.model})` : ''} · ${meta.autonomy} · ${meta.cwd}`);
  write(`$ ${[resolved.bin].concat(argv).map(q).join(' ')}`);

  let cancelled = false;
  let finished = false;
  const st = claude.newState();
  const finish = (code, signal, spawnError) => {
    if (finished) return;
    finished = true;
    const fin = claude.finalize(st);
    const ended = nowIso();
    let error = fin.error || null;
    if (spawnError) error = spawnError;
    else if (code !== 0 && !error) {
      const tail = tailLines(path.join(dir, 'stderr.log'), 3).join(' | ');
      error = `exit ${code}${signal ? ` (${signal})` : ''}${tail ? `: ${truncate(tail, 300)}` : ''}`;
    }
    const status = cancelled ? 'cancelled' : spawnError ? 'failed' : code === 0 && !fin.is_error ? 'done' : 'failed';
    const result = {
      status, exit_code: code, signal: signal || null, final: fin.final || '', report: extractReport(fin.final || ''), session_id: fin.session_id || null, usage: fin.usage || null,
      error, started, ended, duration_ms: new Date(ended) - new Date(started),
    };
    writeJson(path.join(dir, 'result.json'), result);
    runs.patchMeta(id, { status, session_id: result.session_id, ended, child_pid: null });
    runs.logEvent('finished', { id, status, exit_code: code, error: error ? truncate(error, 200) : null });
    write(`# ${status} · exit ${code == null ? '-' : code} · ${fmtDuration(result.duration_ms)}${error ? ` · ${truncate(error, 200)}` : ''}`);
    fs.closeSync(evFd); fs.closeSync(outFd); fs.closeSync(errFd);
    process.exit(0);
  };

  const env = Object.assign({}, process.env);
  for (const k of resolved.unset) delete env[k];
  Object.assign(env, resolved.env, { HH_RUN_ID: id, HH_RUN_DIR: dir });
  let child;
  try {
    child = spawn(resolved.bin, argv, { cwd: meta.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return finish(null, null, `无法启动 ${resolved.bin}: ${e.message}`);
  }
  child.on('error', (e) => finish(null, null, e.code === 'ENOENT' ? `找不到可执行文件 ${resolved.bin}（未安装或不在 PATH）` : `启动失败: ${e.message}`));
  runs.patchMeta(id, { child_pid: child.pid });
  child.stdin.on('error', () => {});
  child.stdin.end(taskText);
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    fs.writeSync(evFd, `${line}\n`);
    let items;
    try { items = claude.parseLine(line, st); } catch (e) { items = [{ kind: 'raw', text: line }]; }
    for (const it of items) write(claude.renderLine(it));
  });
  child.stderr.on('data', (chunk) => { fs.writeSync(errFd, chunk); if (tty) process.stderr.write(chunk); });
  child.on('close', (code, signal) => finish(code, signal));

  const onSignal = () => {
    cancelled = true;
    write('# cancelling…');
    try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 5000).unref();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', () => {}); // herdr tab 被关时不要跟着死
}

module.exports = { main, extractReport };
