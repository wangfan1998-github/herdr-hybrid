'use strict';
// Session policy only. CLI execution stays in adapters; HTTP stays in native.js.
const crypto = require('crypto');
const { HHError } = require('./util');
const MODES = ['external', 'native', 'plain'];
function model(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[^\s<>"'`]+$/.test(value))
    throw new HHError('bad_model', '原生委派模型必须使用 gateway/model（不含空白或标记字符）');
  return value;
}
function validate(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || !MODES.includes(policy.mode)) throw new HHError('bad_mode', `mode 必须是 ${MODES.join('|')}`);
  if (policy.mode !== 'native') return policy;
  model(policy.workerModel);
  for (const key of ['models', 'fallback']) {
    if (policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].length > 4)) throw new HHError('bad_policy', `${key} 必须是至多 4 个模型的数组`);
    for (const m of policy[key] || []) model(m);
  }
  if (policy.effort && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(policy.effort)) throw new HHError('bad_effort', '未知 reasoning effort');
  if (policy.prompt !== undefined && (typeof policy.prompt !== 'string' || policy.prompt.length > 16000)) throw new HHError('bad_prompt', '委派提示必须是至多 16000 字符的文本');
  return policy;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20); }
function plan(profile, policy) {
  validate(policy);
  const targets = [...new Set([policy.workerModel, ...(policy.fallback || [])])];
  const comboId = targets.length > 1 ? `hh-${hash(targets)}` : null;
  const worker = comboId ? `hh/worker-${comboId}` : policy.workerModel;
  const models = [...new Set([worker, ...(policy.models || [])])];
  const roster = models.map((m, i) => ({ name: i === 0 ? 'hh-worker' : `hh-worker-${i + 1}`, model: m }));
  const guidance = [
    '# herdr-hybrid 原生子代理模式',
    '在当前 Agent 内使用原生子代理工具执行独立子任务；主 Agent 负责拆解、整合和验收。',
    '此会话使用原生子代理，不通过 hh dispatch 或 hh MCP 派发同一任务。遵守用户的范围与权限要求。',
    `默认 worker 模型：${worker}。可用子代理：${roster.map(r => `${r.name} → ${r.model}`).join('；')}。`,
    '给子代理完整的目标、目录、文件边界与验收条件。并行修改须分配互不重叠的文件。检查实际 diff 和测试后才能宣布完成。',
    'Codex：spawn_agent 选择目录中的确切模型；需要覆盖模型时不要使用全历史继承，传递独立完整任务。',
    'Claude Code：使用下面定义的 hh-worker 等 subagent_type；model 参数可省略或用 haiku 占位，代理按定义中的路由标记选模型。',
    targets.length > 1 ? `默认 worker 的请求回退顺序：${targets.join(' → ')}。由 hh 内置路由器对尚未输出的可重试请求处理，不自动重跑整个代码任务。` : '未配置模型回退。',
    policy.prompt || '',
  ].filter(Boolean).join('\n');
  return { profile, worker, models, roster, targets, comboId, effort: policy.effort || null, guidance };
}
module.exports = { MODES, validate, plan, hash };
