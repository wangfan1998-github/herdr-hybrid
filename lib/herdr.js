'use strict';
// herdr 只是可选的「观察窗口」：把 worker 跑在一个 tab 里给人看；状态判定完全不依赖它。
const { spawnSync } = require('child_process');
const { HHError, which } = require('./util');
const { HH_BIN, CONFIG_DIR, STATE_DIR } = require('./config');

function exec(args) {
  const r = spawnSync('herdr', args, { encoding: 'utf8' });
  if (r.error) throw new HHError('herdr', `herdr 不可用: ${r.error.message}`);
  if (r.status !== 0) throw new HHError('herdr', `herdr ${args.slice(0, 2).join(' ')} 失败: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return r.stdout;
}

function installed() {
  return !!which('herdr');
}

function available() {
  if (!installed()) return false;
  const r = spawnSync('herdr', ['status'], { encoding: 'utf8' });
  return !r.error && /running/i.test((r.stdout || '') + (r.stderr || ''));
}

function q(s) {
  return /^[A-Za-z0-9_./:=+@%-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createTab(opts) {
  const out = exec(['tab', 'create', '--workspace', opts.workspace || 'w1', '--cwd', opts.cwd, '--label', opts.label, '--no-focus']);
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

// tab 里的新 shell 不继承本进程环境：配置/状态目录用 env 前缀显式带过去（bash/zsh/fish 通吃）
function workerCmdline(id) {
  return `env HH_CONFIG_DIR=${q(CONFIG_DIR)} HH_STATE_DIR=${q(STATE_DIR)} ${q(process.execPath)} ${q(HH_BIN)} _worker ${q(id)}`;
}

// 在 herdr tab 里跑 worker（人能看到实时 transcript）；返回 {tab_id, pane_id}
function openWorker(cfg, meta) {
  const tab = createTab({ workspace: cfg.workspace, cwd: meta.cwd, label: `hh:${meta.label}` });
  sleepSync(2000); // 新 shell 初始化；pty 会缓冲按键，稍慢的 shell 也能收到
  paneRun(tab.pane_id, workerCmdline(meta.id));
  return tab;
}

// 给已在后台跑的 run 开一个只读观察 tab
function openViewer(cfg, meta, outputLog) {
  const tab = createTab({ workspace: cfg.workspace, cwd: meta.cwd, label: `hh:${meta.label}:view` });
  sleepSync(2000);
  paneRun(tab.pane_id, `tail -n 200 -f ${q(outputLog)}`);
  return tab;
}

module.exports = { installed, available, createTab, paneRun, closeTab, openWorker, openViewer };
