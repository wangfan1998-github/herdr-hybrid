/** @type {import('claude-code').Register} */
// hh-config —— hh 的可视化配置界面（Claude Code function hooks / “mod”）。
//
// 设计要点：
//   1. 界面只负责画和收键盘，**所有读写都走 `hh … --json` 子进程**。
//      这样自动继承 hh 已有的校验（validateGateway / validateProfile）、
//      0600 写盘、引用保护（删被引用的端点会被拒），不重复实现一遍逻辑。
//   2. 密钥永远不回显：hh 的 JSON 输出本来就打码成 plat***cQ，界面直接显示即可。
//      只有用户在密钥输入框里主动敲新值时才会把明文传给 hh。
//
// mod 环境的两个硬约束（文档没写，踩出来的）：
//   - 传 $ 的函数必须是本文件顶层的函数声明，不能是闭包里的；所以状态放模块作用域。
//   - 必须有 hooks/hooks.json 的 "modules" 指向本文件，否则根本不加载。
//
// EARLY ACCESS：function hooks 接口可能随 Claude Code 版本变动，升级后跑
// `/plugin-types` 重新生成类型，再跑 `claude plugin test mod/`。

const PANE_ID = 'hh-config';
const VIEWS = ['profiles', 'gateways', 'roles'];

// ---------- 状态 ----------
const state = {
  view: 'profiles',
  rows: [],
  error: '',
  notice: '',
  busy: false,
  open: false,  // pane 开着没有：/hh-config 再敲一次要能关掉
  editing: null, // { name, isNew, fields: {…} }
  // 下拉选项的数据源：进编辑态时从 hh 现拿，保证选出来的端点 / profile 一定存在
  choices: { gateways: [], profiles: [] },
  // 端点的 wire（协议）声明：native 编排要求引用到的每个网关都声明了 wire，
  // 否则保存能过、启动时才炸。留着这份元数据，保存前就能拦住。
  wires: {},
};

// 字段类型：
//   select + options       固定枚举，直接列
//   select + optionsFrom   动态枚举，从 state.choices 取（端点 / profile 列表）
//   （无 type）             自由文本，还是输入框
// 枚举值必须和 lib/config.js 的 AUTH / AUTONOMY、lib/agents 的 NAMES 对齐。
const FIELDS = {
  gateways: [
    { key: 'url', label: '地址 (url)', hint: 'https://…' },
    { key: 'wire', label: '协议 (wire)', type: 'select', options: ['unset', 'responses', 'anthropic', 'chat'], def: 'unset' },
    { key: 'auth', label: '鉴权 (auth)', type: 'select', options: ['token', 'apikey'], def: 'token' },
    { key: 'secret', label: '密钥 (secret)', hint: '留空=不改；可写 env:VAR', secret: true },
  ],
  profiles: [
    { key: 'agent', label: 'agent', type: 'select', options: ['claude', 'codex'], def: 'claude' },
    { key: 'gateway', label: '端点 (gateway)', type: 'select', optionsFrom: 'gateways', extra: ['official'], def: 'official' },
    { key: 'model', label: '模型 (model)', hint: '留空用端点默认' },
    { key: 'mode', label: '编排模式', type: 'select', options: ['external', 'native', 'plain'], def: 'external', policy: true },
    { key: 'workerModel', label: '默认 worker', hint: 'gateway/model', policy: true },
    { key: 'models', label: '可选模型', hint: 'gateway/model，逗号分隔，至多 4 个', policy: true },
    { key: 'fallback', label: '回退顺序', hint: 'gateway/model，逗号分隔，至多 4 个', policy: true },
    { key: 'prompt', label: '委派提示', hint: '附加提示；留空清除', policy: true },
    { key: 'effort', label: '推理强度', type: 'select', options: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], def: 'default', policy: true },
  ],
  roles: [
    { key: 'profile', label: 'profile', type: 'select', optionsFrom: 'profiles' },
    { key: 'autonomy', label: '自主级别', type: 'select', options: ['full', 'workspace', 'readonly'], def: 'full' },
    { key: 'desc', label: '用途 (desc)', hint: '会注入 Leader 的 prompt' },
  ],
};

// 某个字段最终可选的值
function optionsOf(f) {
  if (f.options) return f.options;
  const from = (state.choices[f.optionsFrom] || []).slice();
  return (f.extra || []).concat(from);
}

// ---------- 调 hh ----------
async function hh($, argv) {
  const r = await $.process.run(['hh', ...argv, '--json'], { timeoutMs: 20000 });
  if (r.exitCode !== 0) {
    // hh 的错误信息是给人看的中文，直接透出来
    throw new Error((r.stderr || r.stdout || '').trim() || `hh ${argv.join(' ')} 退出码 ${r.exitCode}`);
  }
  return JSON.parse(r.stdout);
}

// opts.keepError：刷新列表时不要清掉刚刚那次保存/删除的报错
// （否则 hh 的校验失败信息会被紧随其后的 reload 抹掉，用户根本看不到为什么失败）
async function reload($, opts) {
  const keepError = !!(opts && opts.keepError);
  state.busy = true;
  $.ui.invalidate('ui.render');
  try {
    const data = await hh($, [state.view]);
    state.rows = data[state.view] || [];
    if (!keepError) state.error = '';
  } catch (e) {
    state.error = String((e && e.message) || e);
    state.rows = [];
  }
  state.busy = false;
  $.ui.invalidate('ui.render');
}

// /hh-config 是开关：开着就关掉，关着就打开（并刷新一次）
async function togglePane($) {
  if (state.open) {
    await $.ui.close({ id: PANE_ID });
    state.open = false;
    return '面板已关闭';
  }
  await $.ui.open({ id: PANE_ID, title: 'hh — 配置', focus: true, closeOnEscape: true, rows: 16 });
  state.open = true;
  state.editing = null;
  await reload($);
  return '';
}

async function closePane($) {
  state.open = false;
  await $.ui.close({ id: PANE_ID });
}

async function switchView($, v) {
  state.view = v;
  state.editing = null;
  state.notice = '';
  await reload($);
}

// ---------- 编辑 ----------
// 下拉里的端点 / profile 列表从 hh 现拿：选出来的值一定存在，
// 「profile 引用的网关不存在」这类错误从源头上就没了。
async function loadChoices($) {
  try {
    const [gw, pf] = await Promise.all([hh($, ['gateways']), hh($, ['profiles'])]);
    state.choices.gateways = (gw.gateways || []).map((g) => g.name);
    state.choices.profiles = (pf.profiles || []).map((p) => p.name);
    state.wires = {};
    for (const g of gw.gateways || []) state.wires[g.name] = g.wire || '';
  } catch (e) {
    // 拿不到就退化成空列表：下拉至少要有一项，defaultOf 会兜住
    state.choices.gateways = [];
    state.choices.profiles = [];
    state.wires = {};
  }
}

// native 编排要求「主网关 + 所有委派模型的网关」都声明了 wire。
// hh 在启动/plan 时才报这个错，面板要在保存前说清楚，否则用户以为存好了。
// 只在 wires 拿到了的时候判断；拿不到（loadChoices 失败）就不拦，交给 hh 兜底。
function missingWires(fields) {
  if (fields.mode !== 'native' || !Object.keys(state.wires).length) return [];
  const names = [];
  if (fields.gateway && fields.gateway !== 'official') names.push(fields.gateway);
  for (const key of ['workerModel', 'models', 'fallback']) {
    for (const sel of String(fields[key] || '').split(',')) {
      const s = sel.trim();
      if (s.includes('/')) names.push(s.slice(0, s.indexOf('/')));
    }
  }
  return [...new Set(names)].filter((n) => n in state.wires && !state.wires[n]);
}

// 字段的初始值：行里有就用行里的，否则用 def，再否则用第一个可选项（Select 必须有值）
function initialValue(f, row) {
  if (f.secret) return '';                      // 密钥不预填，留空 = 不改
  const v = row ? (f.policy ? (row.orchestration || {})[f.key] : row[f.key]) : undefined;
  if (Array.isArray(v)) return v.join(',');
  if (v != null && v !== '') return String(v);
  if (f.type === 'select') {
    const opts = optionsOf(f);
    return f.def && opts.includes(f.def) ? f.def : (opts[0] || '');
  }
  return '';
}

async function startEdit($, name) {
  await loadChoices($);
  const row = state.rows.find((r) => (r.name || r.role) === name);
  const fields = {};
  for (const f of FIELDS[state.view]) fields[f.key] = initialValue(f, row);
  state.editing = { name, isNew: false, fields };
  state.notice = '';
  $.ui.invalidate('ui.render');
}

async function startCreate($) {
  await loadChoices($);
  const fields = {};
  for (const f of FIELDS[state.view]) fields[f.key] = initialValue(f, null);
  state.editing = { name: '', isNew: true, fields };
  state.notice = '';
  $.ui.invalidate('ui.render');
}

function cancelEdit($) {
  state.editing = null;
  state.error = '';
  $.ui.invalidate('ui.render');
}

function setField($, key, value) {
  if (!state.editing) return;
  if (key === '__name__') state.editing.name = value;
  else state.editing.fields[key] = value;
  $.ui.invalidate('ui.render');
}

// 把编辑框拼成 hh 的参数。留空的字段一律不传 —— 不传 = 不改，避免把已有值清成空。
function buildArgv(view, name, fields) {
  const argv = [view, 'set', name];
  for (const f of FIELDS[view]) {
    if (f.policy) continue;
    const v = (fields[f.key] || '').trim();
    if (!v || (f.key === 'wire' && v === 'unset')) continue;
    argv.push(`--${f.key}`, v);
  }
  if (view === 'profiles') {
    const policy = { mode: fields.mode || 'external', workerModel: (fields.workerModel || '').trim(),
      models: (fields.models || '').split(',').map(v => v.trim()).filter(Boolean),
      fallback: (fields.fallback || '').split(',').map(v => v.trim()).filter(Boolean),
      prompt: fields.prompt || '', effort: fields.effort === 'default' ? '' : fields.effort || '' };
    argv.push('--orchestration', JSON.stringify(policy));
  }
  return argv;
}

async function saveEdit($) {
  if (!state.editing || state.busy) return;
  const name = (state.editing.name || '').trim();
  if (!name) { state.error = '名字不能为空'; $.ui.invalidate('ui.render'); return; }
  // native 用到的网关必须先声明 wire：这里先拦，避免「保存成功、启动才报错」
  if (state.view === 'profiles') {
    const bad = missingWires(state.editing.fields);
    if (bad.length) {
      state.error = `native 需要这些端点声明协议：${bad.join(', ')}（去 gateways 标签页把 wire 设成 responses / anthropic / chat）`;
      $.ui.invalidate('ui.render');
      return;
    }
  }
  state.busy = true;
  $.ui.invalidate('ui.render');
  try {
    await hh($, buildArgv(state.view, name, state.editing.fields));
    state.editing = null;
    state.error = '';
    state.notice = `已保存 ${name}`;
  } catch (e) {
    state.error = String((e && e.message) || e);
  }
  state.busy = false;
  await reload($, { keepError: !!state.error });
}

async function removeRow($, name) {
  state.busy = true;
  $.ui.invalidate('ui.render');
  try {
    await hh($, [state.view, 'rm', name]);
    state.error = '';
    state.notice = `已删除 ${name}`;
  } catch (e) {
    state.error = String((e && e.message) || e); // 被引用时 hh 会拒绝，原样显示
  }
  state.busy = false;
  await reload($, { keepError: !!state.error });
}

// ---------- 渲染 ----------
function rowSummary(r, view) {
  // agent 只在不是默认 claude 时标出来，免得每行都挂个 [claude] 噪音
  const ag = r.agent && r.agent !== 'claude' ? `[${r.agent}] ` : '';
  // wire 决定这个端点能不能给 native 用，列表里直接标出来（未声明的标 wire?）
  if (view === 'gateways') return `${r.url || '-'}   ${r.wire || 'wire?'}   ${r.secret || ''}`;
  if (view === 'profiles') return `${ag}${r.gateway || 'official'}   ${r.model || '-'}   ${(r.orchestration || {}).mode || 'external'}`;
  return `${ag}${r.profile || '-'}   ${r.autonomy || 'full'}   ${r.desc || ''}`;
}

async function registerCommand($) {
  await $.command.register({ name: 'hh-config', description: 'hh：可视化改端点 / profile / 角色' });
}

export const register = (on) => {
  // 斜杠命令要在会话起来时主动注册，光有 command.run 的 hook 是不够的
  // （register() 本身拿不到 $，所以挂在 session.start 上）。
  on('session.start', async ($, e, next) => {
    await registerCommand($);
    return next(e);
  });

  on('command.run', { command: 'hh-config' }, async ($) => {
    const text = await togglePane($);
    return { text };
  });

  // 用户按 Esc 或点关闭时，engine 也会发 ui.close：把 open 标记同步回来，
  // 否则下次敲 /hh-config 会以为还开着，变成「要敲两次才开」。
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) state.open = false;
    return next(e);
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    // pane 用 requestId 认（= $.ui.open 时给的 id）；props 里没有 id。
    if (e.requestId !== PANE_ID) return next(e);
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e);

    const header = h(Box, { gap: 1 },
      ...VIEWS.map((v) => h(Button, {
        key: `tab:${v}`,
        onPress: () => switchView($, v),
      }, v === state.view ? `[${v}]` : ` ${v} `)),
      h(Button, { key: 'new', onPress: () => startCreate($) }, ' + 新建 '),
      h(Button, { key: 'reload', onPress: () => reload($) }, ' ⟳ '),
      h(Button, { key: 'close', onPress: () => closePane($) }, ' ✕ 关闭 '),
    );

    const msgs = [
      state.error ? h(Text, { key: 'err', color: 'red' }, `✗ ${state.error}`) : null,
      state.notice && !state.error ? h(Text, { key: 'ok', color: 'green' }, `✓ ${state.notice}`) : null,
      state.busy ? h(Text, { key: 'busy', dimColor: true }, '处理中…') : null,
    ].filter(Boolean);

    // 一行字段：枚举画 Select（选，不用手敲），自由文本画 Input
    const fieldRow = (f, ed) => {
      const label = h(Text, { bold: true }, f.label.padEnd(14));
      if (f.type === 'select') {
        const opts = [...new Set(optionsOf(f).concat(ed.fields[f.key] ? [ed.fields[f.key]] : []))];
        // Select 的 options 至少要一项且 value 唯一；一项都没有时退化成只读提示，
        // 否则整棵树被引擎拒掉（面板会整个空白）。
        if (!opts.length) {
          return h(Box, { key: `f:${f.key}`, gap: 1 }, label,
            h(Text, { dimColor: true }, `（还没有可选的${f.label}，先去对应标签页建一个）`));
        }
        return h(Box, { key: `f:${f.key}`, gap: 1 }, label,
          h(Select, {
            key: `sel:${f.key}`,
            value: ed.fields[f.key] || opts[0],
            options: opts.map((o) => ({ value: o, label: o })),
            onSelect: (v) => setField($, f.key, v),
          }));
      }
      return h(Box, { key: `f:${f.key}`, gap: 1 }, label,
        h(Input, {
          key: `in:${f.key}`,
          value: ed.fields[f.key],
          placeholder: f.hint,
          onInput: (v) => setField($, f.key, v),
          onSubmit: () => saveEdit($),
        }));
    };

    // 编辑态：名字 + 该视图的字段
    if (state.editing) {
      const ed = state.editing;
      const inputs = [
        ed.isNew
          ? h(Box, { key: 'f:name', gap: 1 },
              h(Text, { bold: true }, '名字'.padEnd(14)),
              h(Input, {
                key: 'in:name',
                value: ed.name,
                autoFocus: true,
                placeholder: '新名字',
                onInput: (v) => setField($, '__name__', v),
                onSubmit: () => saveEdit($),   // 引擎要求每个 Input 都有 onSubmit，少了整棵树画不出来
              }))
          : h(Box, { key: 'f:name', gap: 1 }, h(Text, { bold: true }, '名字'.padEnd(14)), h(Text, {}, ed.name)),
        ...FIELDS[state.view].map((f) => fieldRow(f, ed)),
      ];
      return h(Box, { flexDirection: 'column', gap: 1 },
        header,
        ...msgs,
        h(Text, { key: 'title', bold: true }, `${ed.isNew ? '新建' : '编辑'} ${state.view} ${ed.isNew ? '' : ed.name}`),
        ...inputs,
        h(Box, { key: 'actions', gap: 1 },
          h(Button, { key: 'save', onPress: () => saveEdit($) }, ' 保存 '),
          h(Button, { key: 'cancel', onPress: () => cancelEdit($) }, ' 取消 ')),
        h(Text, { key: 'tip', dimColor: true }, 'Tab 移动焦点，下拉用 ←→ 或回车选。编排字段留空会清除；其他字段留空不变。保存后新会话生效。密钥可写 env:VAR_NAME，配置里就不落明文。'),
      );
    }

    // 列表态
    const list = state.rows.length
      ? state.rows.map((r, i) => {
          const name = r.name || r.role || '';
          return h(Box, { key: `row:${i}`, gap: 1 },
            h(Text, { bold: true }, name.padEnd(14)),
            h(Text, { dimColor: true }, rowSummary(r, state.view)),
            h(Button, { key: `edit:${name}`, onPress: () => startEdit($, name) }, ' 改 '),
            h(Button, { key: `rm:${name}`, onPress: () => removeRow($, name) }, ' 删 '));
        })
      : [h(Text, { key: 'empty', dimColor: true }, state.busy ? '' : '（空）按 + 新建')];

    return h(Box, { flexDirection: 'column', gap: 1 }, header, ...msgs, ...list);
  });
};
