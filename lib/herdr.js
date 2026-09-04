'use strict';
// herdr：可选的观察窗口。状态判定从不经过它；它只负责开 tab、往 pane 里敲命令、关 tab。
// `hh claude` 默认把 Leader 开在 herdr 里（装了就用，没装回退当前终端）；worker 由 runs.js 按 viewer 开 tab。
const { spawn, spawnSync } = require('child_process');
const { HHError, which } = require('./util');
const { HH_BIN, CONFIG_DIR, STATE_DIR } = require('./config');

const INSTALL_CMD = process.platform === 'win32'
  ? 'powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"'
  : 'curl -fsSL https://herdr.dev/install.sh | sh';
const INSTALL_ALT = 'brew install herdr';

function exec(args) {
  const r = spawnSync('herdr', args, { encoding: 'utf8', timeout: 20000 });
  if (r.error) throw new HHError('herdr', `herdr 不可用: ${r.error.message}`);
  if (r.status !== 0) throw new HHError('herdr', `herdr ${args.slice(0, 2).join(' ')} 失败: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return r.stdout;
}

function installed() {
  return !!which('herdr');
}

function available() {
  if (!installed()) return false;
  const r = spawnSync('herdr', ['status'], { encoding: 'utf8', timeout: 10000 });
  return !r.error && /running/i.test((r.stdout || '') + (r.stderr || ''));
}

// 当前进程是否已经跑在 herdr 的某个 pane 里（herdr 给 pane 的 shell 注入这些变量）
function insidePane() {
  return process.env.HERDR_ENV === '1' || !!process.env.HERDR_PANE_ID;
}

function q(s) {
  return /^[A-Za-z0-9_./:=+@%-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// server 没跑就后台拉起一个（`herdr server` = 无头 server），最多等 timeoutMs 看它就绪
function ensureServer(timeoutMs) {
  if (!installed()) return false;
  if (available()) return true;
  try {
    const child = spawn('herdr', ['server'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (e) { return false; }
  const until = Date.now() + (timeoutMs || Number(process.env.HH_HERDR_START_TIMEOUT_MS) || 15000);
  while (Date.now() < until) {
    sleepSync(500);
    if (available()) return true;
  }
  return false;
}

function createTab(opts) {
  const args = ['tab', 'create', '--workspace', opts.workspace || 'w1', '--cwd', opts.cwd, '--label', opts.label];
  if (!opts.focus) args.push('--no-focus');
  const out = exec(args);
  let j;
  try { j = JSON.parse(out); } catch (e) { throw new HHError('herdr', `tab create 返回非 JSON: ${out.slice(0, 200)}`); }
  const tab = j.result && j.result.tab && j.result.tab.tab_id;
  const pane = j.result && j.result.root_pane && j.result.root_pane.pane_id;
  if (!tab || !pane) throw new HHError('herdr', `tab create 返回异常: ${out.slice(0, 200)}`);
  return { tab_id: tab, pane_id: pane };
}

function paneRun(pane, cmdline) {
  exec(['pane', 'run', pane, cmdline]);
}

function closeTab(tabId) {
  exec(['tab', 'close', tabId]);
}

// 新 tab 的 shell 不继承调用方环境，需要的变量写进命令里
function envPrefix() {
  return `env HH_CONFIG_DIR=${q(CONFIG_DIR)} HH_STATE_DIR=${q(STATE_DIR)}`;
}

function workerCmdline(id) {
  return `${envPrefix()} ${q(process.execPath)} ${q(HH_BIN)} _worker ${q(id)}`;
}

// --in-herdr-tab 只用来告诉 tab 里的 hh「原地启动，别再开 tab」；不能用 --no-herdr，那会让 Leader 派的 worker 也不开窗口
function leaderCmdline(argv) {
  return `${envPrefix()} ${q(process.execPath)} ${q(HH_BIN)} claude --in-herdr-tab ${(argv || []).map(q).join(' ')}`.trim();
}

function openWorker(cfg, meta) {
  const tab = createTab({ workspace: cfg.workspace, cwd: meta.cwd, label: `hh:${meta.label}` });
  sleepSync(2000); // 新 shell 初始化；pty 会缓冲按键，稍慢的 shell 也能收到
  paneRun(tab.pane_id, workerCmdline(meta.id));
  return tab;
}

function openViewer(cfg, meta, outputLog) {
  const tab = createTab({ workspace: cfg.workspace, cwd: meta.cwd, label: `hh:${meta.label}:view` });
  sleepSync(2000);
  paneRun(tab.pane_id, `tail -n 200 -f ${q(outputLog)}`);
  return tab;
}

// Leader：开一个聚焦的 tab，在里面跑 `hh claude --no-herdr …`（--no-herdr 防止递归；pane 里 HERDR_ENV 也会挡住）
function openLeader(cfg, opts) {
  const tab = createTab({ workspace: cfg.workspace, cwd: opts.cwd, label: opts.label || 'hh:leader', focus: true });
  sleepSync(2000);
  paneRun(tab.pane_id, leaderCmdline(opts.argv));
  return tab;
}

// 在当前终端附着 herdr 客户端（阻塞到用户退出客户端）
function attach() {
  const r = spawnSync('herdr', [], { stdio: 'inherit' });
  return r.error ? 1 : (r.status == null ? 1 : r.status);
}

module.exports = { INSTALL_CMD, INSTALL_ALT, installed, available, insidePane, ensureServer, createTab, paneRun, closeTab, openWorker, openViewer, openLeader, attach };
