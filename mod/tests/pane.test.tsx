import { test, expect } from 'claude-code/testing';

// 测试环境里插件底下什么都没有，所以 ui.open / command.run / ui.render / process.run
// 都要给底座实现，且底座 hook 必须返回 { value }。
// fake 是一个「假 hh」：记录收到的 argv，按视图回假数据。
function harness(on, opts) {
  opts = opts || {};
  const calls = [];
  on('ui.open', async () => ({ value: {} }));
  on('command.run', async () => ({ value: { text: '' } }));
  on('ui.render', async () => ({ value: null }));
  on('ui.invalidate', async () => ({ value: undefined }));
  on('process.run', async ($$, e) => {
    const argv = e.argv || [];
    calls.push(argv);
    if (argv[0] !== 'hh') return { value: { exitCode: 127, stdout: '', stderr: 'not hh' } };
    if (opts.failOn && argv.includes(opts.failOn)) {
      return { value: { exitCode: 1, stdout: '', stderr: opts.failMessage || '出错了' } };
    }
    const view = argv[1];
    const data = {
      profiles: [
        { name: 'official', agent: 'claude', gateway: null, model: null },
        { name: 'o50', agent: 'claude', gateway: 'relay', model: 'vendor/coding-fast' },
        { name: 'cx', agent: 'codex', gateway: 'relay', model: 'gpt-5.4', orchestration: opts.policy },
      ],
      gateways: [
        { name: 'relay', url: 'https://relay.example.com', auth: 'token', secret: 'sk-a***90', wire: 'chat' },
        ...(opts.extraGateways || []),
      ],
      roles: [{ role: 'coder', agent: 'claude', profile: 'o50', autonomy: 'full', desc: '实现改动' }],
    };
    return { value: { exitCode: 0, stdout: JSON.stringify({ [view]: data[view] || [] }), stderr: '' } };
  });
  return calls;
}

const PANE = { surface: 'terminal', component: 'Pane', requestId: 'hh-config', props: { title: 'hh — 配置', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: {}, view: {} } };

// 引擎会校验渲染树，不合法就整棵不画（线上表现：面板空白 + "hook skipped: threw"）。
// 之前只断言 JSON 里有没有某个字符串，缺 onSubmit 这种照样绿 —— 所以这里显式走一遍必填项。
// 必填项来自 claude-code.d.ts：Input.onSubmit、Button.onPress、Select.{options,onSelect}。
//
// 注意树里的形状：回调不会留在 props 里，引擎把它们收成一个 handle，挂在节点的
// `press` 上（Input / Button / Select 都是这个字段）。所以判据是「有没有 handle」，
// 不是「props 里有没有 onSubmit」—— 后者永远是 undefined，那样写等于没校验。
function assertValidTree(node, path) {
  path = path || 'root';
  if (node == null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return 0;
  if (Array.isArray(node)) return node.reduce((n, c, i) => n + assertValidTree(c, `${path}[${i}]`), 0);

  const t = node.type;
  const p = node.props || {};
  const where = `${path} <${t} key=${p.key || '-'}>`;
  const hasHandler = node.press && typeof node.press.handle === 'number';
  if (t === 'Input') {
    // 引擎原话：returned an Input without an onSubmit function
    if (!hasHandler) throw new Error(`${where} 缺 onSubmit（树里没有 press handle）`);
    if (!p.key) throw new Error(`${where} 缺 key`);
  }
  if (t === 'Button') {
    if (!hasHandler) throw new Error(`${where} 缺 onPress（树里没有 press handle）`);
    if (!p.key) throw new Error(`${where} 缺 key`);
  }
  if (t === 'Select') {
    if (!hasHandler) throw new Error(`${where} 缺 onSelect（树里没有 press handle）`);
    if (!p.key) throw new Error(`${where} 缺 key`);
    // options 至少一项、value 唯一，且 value 必须在 options 里 —— 否则引擎拒整棵树
    const opts = p.options || [];
    if (!opts.length) throw new Error(`${where} options 为空`);
    const vals = opts.map((o) => o.value);
    if (new Set(vals).size !== vals.length) throw new Error(`${where} options 的 value 有重复: ${vals.join(',')}`);
    if (p.value != null && !vals.includes(p.value)) throw new Error(`${where} value=${p.value} 不在 options 里`);
  }
  const kids = node.children == null ? [] : [].concat(node.children);
  return 1 + kids.reduce((n, c, i) => n + assertValidTree(c, `${where}>${i}`), 0);
}

// 画一次并校验；返回 [树, 文本] 方便断言内容
async function draw($) {
  const tree = await $.ui.render(PANE);
  assertValidTree(tree);
  return [tree, JSON.stringify(tree)];
}

// 按 key 找节点，用来断言 Select 的 options / value
function findByKey(node, key) {
  if (node == null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const c of node) { const r = findByKey(c, key); if (r) return r; }
    return undefined;
  }
  if (node.props && node.props.key === key) return node;
  return findByKey(node.children, key);
}

test('会话启动时真的注册了 /hh-config 斜杠命令', async ($, on) => {
  const registered = [];
  on('session.start', async () => ({ cwd: '/tmp' }));
  on('command.register', async ($$, e) => {
    registered.push(e.name);
    return { value: { command: e.name } };
  });
  await $.session.start({ cwd: '/tmp' });
  expect(registered).toContain('hh-config');
});

test('/hh-config 是开关：再敲一次关掉面板', async ($, on) => {
  const opened = [];
  const closed = [];
  on('ui.open', async ($$, e) => { opened.push(e.id); return { value: {} }; });
  on('ui.close', async ($$, e) => { closed.push(e.id); return { value: {} }; });
  on('command.run', async () => ({ value: { text: '' } }));
  on('ui.render', async () => ({ value: null }));
  on('ui.invalidate', async () => ({ value: undefined }));
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '{"profiles":[]}', stderr: '' } }));

  await $.command.run({ command: 'hh-config', args: '' });   // 开
  expect(opened).toContain('hh-config');
  expect(closed.length).toBe(0);

  await $.command.run({ command: 'hh-config', args: '' });   // 再敲 → 关
  expect(closed).toContain('hh-config');
  expect(opened.length).toBe(1);

  await $.command.run({ command: 'hh-config', args: '' });   // 第三次 → 又开
  expect(opened.length).toBe(2);
});

test('列表：渲染 hh 给的 profile 行', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  const [, text] = await draw($);
  expect(text).toContain('o50');
  expect(text).toContain('relay');
});

// 这条覆盖线上真实炸过的那次：点「+ 新建」后名字输入框缺 onSubmit，整棵树被引擎拒绝。
test('每个视图的「+ 新建」和「改」都画得出合法的树', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);

  for (const view of ['profiles', 'gateways', 'roles']) {
    await $.ui.press({ plugin: 'hh-config', key: `tab:${view}` });
    await draw($);                                             // 列表态

    await $.ui.press({ plugin: 'hh-config', key: 'new' });      // 新建态
    const [, newText] = await draw($);
    expect(newText).toContain('新建');

    await $.ui.press({ plugin: 'hh-config', key: 'cancel' });   // 退回列表
    await draw($);

    const row = { profiles: 'o50', gateways: 'relay', roles: 'coder' }[view];
    await $.ui.press({ plugin: 'hh-config', key: `edit:${row}` }); // 编辑态
    const [, editText] = await draw($);
    expect(editText).toContain('编辑');

    await $.ui.press({ plugin: 'hh-config', key: 'cancel' });
    await draw($);
  }
});

test('新建时名字留空 → 提示且不调 hh set', async ($, on) => {
  const calls = harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'new' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'save' });      // 没填名字就保存
  const [, text] = await draw($);
  expect(text).toContain('名字不能为空');
  expect(calls.some((a) => a[2] === 'set')).toBe(false);
});

test('密钥只显示打码值，不出现明文', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($); // 先画出来，按钮才存在
  // 切到 gateways
  await $.ui.press({ plugin: 'hh-config', key: 'tab:gateways' });
  const [, text] = await draw($);
  expect(text).toContain('sk-a***90');
  // 打码值本身带前缀，所以不能拿前缀当「明文」判据；用一个只可能出现在明文里的串。
  expect(text).not.toContain('sk-aaaa1234567890');
});

test('编辑并保存：调 hh <view> set，且不传留空的字段', async ($, on) => {
  const calls = harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:o50' });
  await draw($); // 进编辑态，保存按钮才出现
  await $.ui.press({ plugin: 'hh-config', key: 'save' });

  const set = calls.find((a) => a[1] === 'profiles' && a[2] === 'set');
  expect(set).toBeDefined();
  expect(set).toContain('o50');
  expect(set).toContain('--gateway');
  expect(set).toContain('--json');
  // 密钥框留空 → 不该带 --secret（否则会把已有密钥清掉）
  expect(set).not.toContain('--secret');
});

test('hh 报错（比如被引用不让删）时，错误原样显示在界面上', async ($, on) => {
  harness(on, { failOn: 'rm', failMessage: 'profile o50 仍被角色引用: coder' });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'rm:o50' });
  const [, text] = await draw($);
  expect(text).toContain('仍被角色引用');
});

test('✕ 关闭按钮真的关面板', async ($, on) => {
  const closed = [];
  harness(on);
  on('ui.close', async ($$, e) => { closed.push(e.id); return { value: {} }; });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'close' });
  expect(closed).toContain('hh-config');
});

// ---------- 下拉选项 ----------

test('枚举字段画成 Select 而不是输入框', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'new' });
  const [, text] = await draw($);
  // profiles 视图：agent 和 gateway 都该是 Select；model 仍是 Input
  expect(text).toContain('sel:agent');
  expect(text).toContain('sel:gateway');
  expect(text).toContain('in:model');
  expect(text).not.toContain('in:agent');
  expect(text).not.toContain('in:gateway');
});

test('agent 下拉列出 claude 和 codex', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'new' });
  const [tree] = await draw($);
  const sel = findByKey(tree, 'sel:agent');
  expect(sel).toBeDefined();
  expect(sel.props.options.map((o) => o.value)).toEqual(['claude', 'codex']);
});

test('端点下拉的选项来自现有端点（不是手敲）', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'new' });
  const [tree] = await draw($);
  const sel = findByKey(tree, 'sel:gateway');
  // official + 假 hh 里那一个端点
  expect(sel.props.options.map((o) => o.value)).toEqual(['official', 'relay']);
});

test('roles 的 profile 下拉列出现有 profile，autonomy 是固定三档', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'tab:roles' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'new' });
  const [tree] = await draw($);
  expect(findByKey(tree, 'sel:profile').props.options.map((o) => o.value)).toEqual(['official', 'o50', 'cx']);
  expect(findByKey(tree, 'sel:autonomy').props.options.map((o) => o.value)).toEqual(['full', 'workspace', 'readonly']);
});

test('编辑 codex profile 时 agent 下拉预选 codex', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });
  const [tree] = await draw($);
  expect(findByKey(tree, 'sel:agent').props.value).toBe('codex');
});

// 测试 kit 的 $.ui 只有 render / scroll / focus / press —— 没有 select / input，
// 没法从测试里「选一个下拉项」。所以这里退一步验证等价的东西：
//   1. Select 的 onSelect 确实接到了 setField（下面 assertValidTree 已保证 handler 存在）
//   2. 把 agent 直接写进编辑态后，buildArgv 会带上 --agent —— 这是「选了会存下去」的实际逻辑
// 真正的「鼠标点下拉」只能在 TUI 里手测，README 里已注明。
test('agent 字段有值时，保存会带 --agent（下拉选中后走的就是这条路）', async ($, on) => {
  const calls = harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });   // cx 是 codex profile
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'save' });

  const set = calls.find((a) => a[1] === 'profiles' && a[2] === 'set');
  expect(set).toBeDefined();
  expect(set).toContain('cx');
  expect(set).toContain('--agent');
  expect(set).toContain('codex');      // 预选值原样带回去，不会把 codex profile 存成 claude
});

test('codex profile 在列表里标出 [codex]', async ($, on) => {
  harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  const [, text] = await draw($);
  expect(text).toContain('[codex]');
  expect(text).not.toContain('[claude]');   // 默认 agent 不刷噪音
});



test('编排字段渲染且完整策略与 profile 单次原子保存', async ($, on) => {
  const policy = { mode: 'native', workerModel: 'relay/worker', models: ['relay/second'], fallback: ['relay/backup'], prompt: '检查结果', effort: 'high' };
  const calls = harness(on, { policy });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });
  const [tree] = await draw($);
  expect(findByKey(tree, 'sel:mode').props.value).toBe('native');
  expect(findByKey(tree, 'in:workerModel').props.value).toBe(policy.workerModel);
  expect(findByKey(tree, 'in:models').props.value).toBe('relay/second');
  expect(findByKey(tree, 'in:fallback').props.value).toBe('relay/backup');
  expect(findByKey(tree, 'sel:effort').props.value).toBe('high');
  await $.ui.press({ plugin: 'hh-config', key: 'save' });
  const mutations = calls.filter(a => a[2] === 'set');
  expect(mutations.length).toBe(1);
  const argv = mutations[0];
  expect(JSON.parse(argv[argv.indexOf('--orchestration') + 1])).toEqual(policy);
});

test('网关 wire 显示并保存，保留空密钥不覆盖的行为', async ($, on) => {
  const calls = harness(on);
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'tab:gateways' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:relay' });
  const [tree] = await draw($);
  expect(findByKey(tree, 'sel:wire').props.value).toBe('chat');
  await $.ui.press({ plugin: 'hh-config', key: 'save' });
  const argv = calls.find(a => a[2] === 'set');
  expect(argv[argv.indexOf('--wire') + 1]).toBe('chat');
  expect(argv).not.toContain('--secret');
});

test('保存失败保留编排编辑状态与错误，不能显示成功', async ($, on) => {
  harness(on, { failOn: 'set', failMessage: 'worker 网关不存在', policy: { mode: 'native', workerModel: 'missing/worker' } });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'save' });
  const [tree, text] = await draw($);
  expect(text).toContain('worker 网关不存在');
  expect(text).not.toContain('已保存');
  expect(findByKey(tree, 'in:workerModel').props.value).toBe('missing/worker');
});

// native 引用的网关必须先声明 wire。hh 只在 plan / 启动时报这个错，
// 面板要在保存前就拦住——否则用户以为存好了，等到启动才发现不能用。
test('native 引用的网关没声明 wire 时，保存前就拦住且不调 hh set', async ($, on) => {
  const calls = harness(on, {
    extraGateways: [{ name: 'nowire', url: 'https://nw.example.com/v1', auth: 'apikey', secret: 'sk-***12', wire: null }],
    policy: { mode: 'native', workerModel: 'nowire/worker' },
  });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'save' });
  const [tree, text] = await draw($);
  expect(text).toContain('nowire');
  expect(text).not.toContain('已保存');
  // 关键：没有把非法策略发给 hh
  expect(calls.some((a) => a[2] === 'set')).toBe(false);
  // 编辑内容保留，用户改完能直接再存
  expect(findByKey(tree, 'in:workerModel').props.value).toBe('nowire/worker');
});

test('wire 齐全的 native 策略照常保存', async ($, on) => {
  const calls = harness(on, { policy: { mode: 'native', workerModel: 'relay/worker' } });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'save' });
  const argv = calls.find((a) => a[2] === 'set');
  expect(argv).toBeTruthy();
  expect(JSON.parse(argv[argv.indexOf('--orchestration') + 1]).workerModel).toBe('relay/worker');
});

test('external 模式不校验 wire（只有 native 才要求）', async ($, on) => {
  const calls = harness(on, {
    extraGateways: [{ name: 'nowire', url: 'https://nw.example.com/v1', auth: 'apikey', secret: 'sk-***12', wire: null }],
    policy: { mode: 'external', workerModel: 'nowire/worker' },
  });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'edit:cx' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'save' });
  expect(calls.some((a) => a[2] === 'set')).toBe(true);
});

test('网关列表标出未声明 wire 的端点', async ($, on) => {
  harness(on, { extraGateways: [{ name: 'nowire', url: 'https://nw.example.com/v1', auth: 'apikey', secret: 'sk-***12', wire: null }] });
  await $.command.run({ command: 'hh-config', args: '' });
  await draw($);
  await $.ui.press({ plugin: 'hh-config', key: 'tab:gateways' });
  const [, text] = await draw($);
  expect(text).toContain('wire?');
  expect(text).toContain('chat');
});
