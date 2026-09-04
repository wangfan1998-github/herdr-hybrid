'use strict';
// run = 一次派发。目录即状态：~/.local/state/hh/runs/<id>/{meta.json,task.md,events.jsonl,output.log,stderr.log,result.json}
// 完成 = worker 进程退出并写下 result.json；不抓屏、不问「已完成」。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HHError, expandHome, readJson, writeJson, readText, appendLine, nowIso, stamp, slug, rand, pidAlive, tailLines, sleep, truncate } = require('./util');
const config = require('./config');
const herdr = require('./herdr');

const RUNS_DIR = path.join(config.STATE_DIR, 'runs');
const EVENTS_FILE = path.join(config.STATE_DIR, 'events.jsonl');
const SETTLED = new Set(['done', 'failed', 'cancelled', 'crashed']);
const STARTING_GRACE_MS = 90 * 1000;

function runDir(id) { return path.join(RUNS_DIR, id); }
function metaPath(id) { return path.join(runDir(id), 'meta.json'); }
function resultPath(id) { return path.join(runDir(id), 'result.json'); }

function logEvent(kind, data) {
  try { appendLine(EVENTS_FILE, JSON.stringify(Object.assign({ ts: nowIso() }, data, { kind }))); } catch (e) { /* ignore */ }
}

function listIds() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR).filter((d) => fs.existsSync(metaPath(d))).sort();
}

function resolveId(ref) {
  if (!ref) throw new HHError('need_id', '需要 run id（hh status 查看）');
  if (fs.existsSync(metaPath(ref))) return ref;
  const ids = listIds();
  const m = ids.filter((i) => i.startsWith(ref) || i.endsWith(`-${ref}`) || i.includes(`-${ref}-`));
  if (m.length === 1) return m[0];
  if (m.length > 1) throw new HHError('ambiguous', `run 引用不唯一: ${ref} → ${m.slice(-5).join(', ')}（用完整 id）`);
  throw new HHError('no_run', `run 不存在: ${ref}`);
}

function readMeta(id) { return readJson(metaPath(id)); }
function saveMeta(meta) { writeJson(metaPath(meta.id), meta); }
function patchMeta(id, patch) { const m = readMeta(id); Object.assign(m, patch); saveMeta(m); return m; }
function readResult(id) { return readJson(resultPath(id), null); }

// 计算状态：result.json 有 → 用它；worker 活着 → running；否则 crashed（并落盘，让它 settled）
function status(id) {
  const meta = readMeta(id);
  const res = readResult(id);
  if (res) return { meta, result: res, status: res.status };
  if (meta.worker_pid && pidAlive(meta.worker_pid)) return { meta, result: null, status: 'running' };
  if (!meta.worker_pid && Date.now() - new Date(meta.created).getTime() < STARTING_GRACE_MS) return { meta, result: null, status: 'starting' };
  const crashed = {
    status: 'crashed', exit_code: null, signal: null, final: '', session_id: meta.session_id || null, usage: null,
    error: meta.worker_pid ? 'worker 进程已消失且未写 result.json' : 'worker 从未启动（herdr tab 没跑起来？看 hh doctor）',
    started: meta.started || null, ended: nowIso(), duration_ms: null,
  };
  writeJson(resultPath(id), crashed);
  patchMeta(id, { status: 'crashed', ended: crashed.ended });
  logEvent('crashed', { id, error: crashed.error });
  return { meta: readMeta(id), result: crashed, status: 'crashed' };
}

function summary(id, opts) {
  opts = opts || {};
  const { meta, result, status: st } = status(id);
  const s = {
    id, status: st, label: meta.label, role: meta.role, profile: meta.profile, gateway: meta.gateway || null, model: meta.model || null, autonomy: meta.autonomy,
    cwd: meta.cwd, created: meta.created, started: meta.started || null, ended: (result && result.ended) || null,
    duration_ms: result && result.duration_ms != null ? result.duration_ms : (meta.started ? Date.now() - new Date(meta.started).getTime() : null),
    exit_code: result ? result.exit_code : null, session_id: (result && result.session_id) || meta.session_id || null,
    parent: meta.parent || null, viewer: meta.viewer || null, dir: runDir(id), task_file: path.join(runDir(id), 'task.md'),
    error: (result && result.error) || null,
  };
  if (result) s.final = opts.full ? result.final : truncate(result.final || '', 400);
  if (result) s.report = result.report || null;
  if (result && result.usage) s.usage = result.usage;
  return s;
}

function composeTask(p) {
  if (p.resume) return `${p.task.trim()}\n\n${p.footer || ''}`.trim() + '\n';
  const head = [
    `# 任务：${p.label}`,
    '',
    `- 角色: ${p.role || '（无）'}    profile: ${p.profile}${p.gateway ? ` (${p.gateway}` : ' (official'}${p.model ? `, ${p.model}` : ''})    autonomy: ${p.autonomy}    工作目录: ${p.cwd}    run: ${p.id}    创建: ${p.created}`,
    '',
  ];
  const body = [];
  if (p.template) body.push('## 角色规范', '', p.template.trim(), '');
  body.push('## 任务', '', p.task.trim(), '');
  if (p.footer) body.push(p.footer.trim(), '');
  return head.concat(body).join('\n');
}

function spawnDetached(meta) {
  const child = spawn(process.execPath, [config.HH_BIN, '_worker', meta.id], { detached: true, stdio: 'ignore', cwd: meta.cwd, env: process.env });
  child.unref();
  patchMeta(meta.id, { worker_pid: child.pid, status: 'running', launch: 'detached' });
}

// opts: {role, profile, model, autonomy, label, cwd, task, taskFile, resume, parent, view, noTemplate}
function createRun(cfg, opts) {
  let r = null;
  if (opts.role) r = config.resolveRole(cfg, opts.role);
  const profileName = opts.profile || (r && r.profileName);
  if (!profileName) throw new HHError('need_role', '需要 -r ROLE 或 -p PROFILE');
  // -p 覆盖了 profile 就用该 profile 自己的模型；角色上的 model 只跟角色原 profile 走（否则会把 A 网关的模型 id 发到 B 网关）
  const resolved = config.resolveProfile(cfg, profileName, opts.model || (opts.profile ? '' : (r && r.model) || ''));
  const autonomy = opts.autonomy || (r && r.autonomy) || 'full';
  if (!config.AUTONOMY.includes(autonomy)) throw new HHError('bad_autonomy', `autonomy 必须是 ${config.AUTONOMY.join('|')}: ${autonomy}`);
  const cwd = path.resolve(expandHome(opts.cwd || process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new HHError('no_dir', `目录不存在: ${cwd}`);
  let task = opts.task;
  if (opts.taskFile) task = readText(expandHome(opts.taskFile));
  if (!task || !task.trim()) throw new HHError('need_task', '需要 -f TASK_FILE 或 -t "TASK"');
  const label = opts.label || opts.role || profileName;
  const id = `${stamp()}-${slug(label)}-${rand(4)}`;
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const template = !opts.noTemplate && r && r.template && fs.existsSync(r.template) ? readText(r.template) : '';
  const created = nowIso();
  fs.writeFileSync(path.join(dir, 'task.md'), composeTask({
    label, role: opts.role || null, profile: profileName, gateway: resolved.gatewayName, model: resolved.model, autonomy, cwd, id, created, template, task, footer: opts.noFooter ? '' : cfg.footer, resume: opts.resume,
  }));
  const meta = {
    id, label, role: opts.role || null, profile: profileName, gateway: resolved.gatewayName, model: resolved.model, autonomy, cwd, created,
    status: 'starting', parent: opts.parent || null, resume: opts.resume || null, viewer: null, worker_pid: null, child_pid: null,
  };
  saveMeta(meta);
  const view = opts.view === undefined || opts.view === null ? config.effectiveViewer(cfg) : opts.view;
  const wantHerdr = view === 'herdr' || view === true || (view === 'auto' && herdr.available());
  if (wantHerdr) {
    try {
      const tab = herdr.openWorker(cfg, meta);
      patchMeta(id, { viewer: { tab_id: tab.tab_id, pane_id: tab.pane_id }, launch: 'herdr' });
    } catch (e) {
      patchMeta(id, { viewer_error: e.message });
      spawnDetached(meta);
    }
  } else {
    spawnDetached(meta);
  }
  logEvent('dispatch', { id, label, role: meta.role, profile: profileName, gateway: resolved.gatewayName, model: resolved.model, cwd, parent: meta.parent, resume: !!opts.resume });
  return summary(id);
}

async function waitRuns(ids, opts) {
  opts = opts || {};
  const timeout = opts.timeout == null ? 540 : Number(opts.timeout);
  const interval = opts.interval == null ? 3 : Number(opts.interval);
  const start = Date.now();
  let last = '';
  for (;;) {
    const st = ids.map((id) => ({ id, status: status(id).status }));
    const line = st.map((s) => `${s.id}=${s.status}`).join(' ');
    if (line !== last) { last = line; if (opts.onChange) opts.onChange(st); }
    if (st.every((s) => SETTLED.has(s.status))) return { settled: true, elapsed_s: Math.round((Date.now() - start) / 1000), runs: ids.map((id) => summary(id)) };
    if ((Date.now() - start) / 1000 >= timeout) return { settled: false, elapsed_s: Math.round((Date.now() - start) / 1000), runs: ids.map((id) => summary(id)) };
    await sleep(interval * 1000);
  }
}

function listRuns(opts) {
  opts = opts || {};
  const all = listIds().map((id) => summary(id));
  if (opts.all) return all.slice(-(opts.limit || 200));
  const running = all.filter((s) => !SETTLED.has(s.status));
  const settled = all.filter((s) => SETTLED.has(s.status)).slice(-(opts.limit || 10));
  return settled.concat(running).sort((a, b) => a.created.localeCompare(b.created));
}

function readOutput(id, opts) {
  opts = opts || {};
  const n = opts.lines == null ? 60 : Number(opts.lines);
  const file = path.join(runDir(id), opts.raw ? 'events.jsonl' : 'output.log');
  const lines = tailLines(file, n);
  if (!opts.raw && opts.stderr !== false) {
    const err = tailLines(path.join(runDir(id), 'stderr.log'), 5);
    if (err.length) lines.push('--- stderr (tail) ---', ...err);
  }
  return lines;
}

function sendFollowup(cfg, id, text, opts) {
  opts = opts || {};
  const { meta, result, status: st } = status(id);
  if (!SETTLED.has(st)) throw new HHError('running', `${id} 仍在 ${st}，先 hh wait 或 hh cancel`);
  const session = result && result.session_id;
  const siblings = listIds().filter((i) => { try { return readMeta(i).parent === id; } catch (e) { return false; } }).length;
  let task = text;
  if (!session) task = `这是对上一轮任务（run ${id}）的追加指令。上一轮你的最终回复是：\n\n${result ? result.final : ''}\n\n---\n\n${text}`;
  return createRun(cfg, {
    role: meta.role, profile: meta.profile, model: meta.model, autonomy: opts.autonomy || meta.autonomy, label: `${meta.label}-r${siblings + 1}`,
    cwd: meta.cwd, task, resume: session || null, parent: id, view: opts.view, noTemplate: !!session,
  });
}

async function cancelRun(id) {
  const { meta, status: st } = status(id);
  if (SETTLED.has(st)) throw new HHError('settled', `${id} 已经是 ${st}`);
  const tryKill = (pid, sig) => { if (!pid) return; try { process.kill(pid, sig); } catch (e) { /* gone */ } };
  tryKill(meta.worker_pid, 'SIGTERM'); // worker 会 SIGTERM 子进程并把状态记成 cancelled
  for (let i = 0; i < 20; i++) { if (readResult(id)) break; await sleep(250); }
  if (!readResult(id)) {
    if (meta.worker_pid) { try { process.kill(-meta.worker_pid, 'SIGKILL'); } catch (e) { tryKill(meta.worker_pid, 'SIGKILL'); } }
    tryKill(meta.child_pid, 'SIGKILL');
    writeJson(resultPath(id), { status: 'cancelled', exit_code: null, signal: 'SIGKILL', final: '', session_id: meta.session_id || null, usage: null, error: '被 hh cancel 强制终止', started: meta.started || null, ended: nowIso(), duration_ms: null });
  }
  const res = readResult(id);
  if (res.status !== 'cancelled') { res.status = 'cancelled'; res.error = res.error || '被 hh cancel 终止'; writeJson(resultPath(id), res); }
  patchMeta(id, { status: 'cancelled', ended: res.ended || nowIso() });
  logEvent('cancel', { id });
  return summary(id);
}

function closeRun(cfg, id, opts) {
  opts = opts || {};
  const { meta, status: st } = status(id);
  if (!SETTLED.has(st) && !opts.force) throw new HHError('running', `${id} 仍在 ${st}；要连进程一起结束用 --force`);
  const out = { id, status: st, tab_closed: false };
  if (meta.viewer && meta.viewer.tab_id) {
    try { herdr.closeTab(meta.viewer.tab_id); out.tab_closed = true; } catch (e) { out.tab_error = e.message; }
    patchMeta(id, { viewer_closed: true });
  }
  logEvent('close', { id, forced: !!opts.force });
  return out;
}

function cleanRuns(opts) {
  opts = opts || {};
  const days = opts.days == null ? 7 : Number(opts.days);
  const cutoff = Date.now() - days * 86400 * 1000;
  const removed = [];
  for (const id of listIds()) {
    const s = status(id);
    if (!SETTLED.has(s.status) || new Date(s.meta.created).getTime() > cutoff) continue;
    fs.rmSync(runDir(id), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

function recentEvents(n) {
  return tailLines(EVENTS_FILE, n || 20).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
}

module.exports = {
  RUNS_DIR, EVENTS_FILE, SETTLED, runDir, listIds, resolveId, readMeta, patchMeta, readResult, status, summary, createRun, waitRuns,
  listRuns, readOutput, sendFollowup, cancelRun, closeRun, cleanRuns, recentEvents, logEvent,
};
