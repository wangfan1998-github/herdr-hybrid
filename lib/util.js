'use strict';
// 通用小工具：文件/JSON/时间/进程/路径。零依赖。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class HHError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function shortHome(p) {
  const h = os.homedir();
  return p && p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new HHError('bad_json', `无法读取 JSON: ${file}: ${e.message}`);
  }
}

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

function readText(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new HHError('not_found', `文件不存在: ${file}`);
  }
}

function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}

function nowIso() {
  return new Date().toISOString();
}

function stamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(s, max) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.slice(0, max || 32) || 'task';
}

function rand(n) {
  return crypto.randomBytes(8).toString('hex').slice(0, n || 4);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function which(bin) {
  if (!bin) return null;
  if (bin.includes('/')) return fs.existsSync(expandHome(bin)) ? expandHome(bin) : null;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const f = path.join(d, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch (e) { /* next */ }
  }
  return null;
}

function tailLines(file, n) {
  const text = readText(file, '');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return n ? lines.slice(-n) : lines;
}

function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function ago(iso) {
  if (!iso) return '-';
  return fmtDuration(Date.now() - new Date(iso).getTime());
}

function mask(v) {
  v = String(v == null ? '' : v);
  if (v.length > 10) return `${v.slice(0, 4)}***${v.slice(-2)}`;
  return v ? '***' : '';
}

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;
function maskEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = SECRET_RE.test(k) ? mask(v) : v;
  return out;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\r/g;
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  HHError, expandHome, shortHome, readJson, writeJson, readText, appendLine, nowIso, stamp, slug, rand,
  pidAlive, which, tailLines, fmtDuration, ago, mask, maskEnv, stripAnsi, truncate, sleep,
};
