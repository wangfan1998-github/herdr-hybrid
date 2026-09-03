'use strict';
// Claude Code 适配：无头命令（claude -p --output-format stream-json）、事件流解析、交互式启动参数。
const { truncate } = require('./util');

const INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'notebook_path'];
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of INPUT_KEYS) if (input[k]) return truncate(String(input[k]), 100);
  return truncate(JSON.stringify(input), 100);
}

function autonomyArgs(autonomy) {
  if (autonomy === 'full') return ['--permission-mode', 'bypassPermissions'];
  if (autonomy === 'workspace') return ['--permission-mode', 'acceptEdits'];
  return ['--permission-mode', 'default', '--allowedTools', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
}

// ctx: { model, autonomy, resume, args }
function headlessArgv(ctx) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'].concat(autonomyArgs(ctx.autonomy || 'full'));
  if (ctx.model) a.push('--model', ctx.model);
  if (ctx.resume) a.push('--resume', ctx.resume);
  a.push(...(ctx.args || []));
  return a;
}

// 交互式：hh claude <profile> [args…]
function interactiveArgv(cfg, profileArgs, extra) {
  return (cfg.claude.interactiveArgs || []).concat(profileArgs || [], extra || []);
}

function newState() {
  return { texts: [], rawLines: [], session_id: null, final: null, usage: null, is_error: false, error: null, sawJson: false };
}

function tryJson(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

function parseLine(line, st) {
  const ev = tryJson(line);
  if (!ev) { st.rawLines.push(line); return [{ kind: 'raw', text: line }]; }
  st.sawJson = true;
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    st.session_id = ev.session_id || st.session_id;
    out.push({ kind: 'info', text: `init model=${ev.model || '?'} mode=${ev.permissionMode || '?'}` });
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text) { st.texts.push(c.text); out.push({ kind: 'text', text: c.text }); }
      else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}` });
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type !== 'tool_result' || !c.is_error) continue;
      const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : '';
      out.push({ kind: 'tool_result', text: truncate(t, 200), error: true });
    }
  } else if (ev.type === 'result') {
    st.session_id = ev.session_id || st.session_id;
    st.is_error = !!ev.is_error;
    if (typeof ev.result === 'string' && ev.result) st.final = ev.result;
    st.usage = {
      cost_usd: ev.total_cost_usd, turns: ev.num_turns, duration_ms: ev.duration_ms,
      input_tokens: ev.usage && ev.usage.input_tokens, output_tokens: ev.usage && ev.usage.output_tokens,
    };
    if (ev.subtype && ev.subtype !== 'success') st.error = ev.subtype + (ev.result ? `: ${truncate(ev.result, 300)}` : '');
    out.push({ kind: 'result', text: ev.subtype || 'result' });
  }
  return out;
}

function finalize(st) {
  const final = st.final || st.texts[st.texts.length - 1] || (!st.sawJson ? st.rawLines.join('\n').trim() : '');
  return { final, session_id: st.session_id, usage: st.usage, is_error: st.is_error, error: st.error };
}

function renderLine(item) {
  switch (item.kind) {
    case 'text': return item.text.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)).join('\n');
    case 'tool': return `  ⚙ ${item.text}`;
    case 'tool_result': return `  ↳ ${item.error ? '✗ ' : ''}${item.text}`;
    case 'info': return `  · ${item.text}`;
    case 'result': return `  ■ ${item.text}`;
    case 'error': return `  ✗ ${item.text}`;
    default: return item.text;
  }
}

module.exports = { headlessArgv, interactiveArgv, autonomyArgs, newState, parseLine, finalize, renderLine };
