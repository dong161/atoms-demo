import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, pickTemplate, mockCreate, mockEdit, mockPlan } from '../server/agents.js';
import { staticCheck } from '../server/html.js';

const primaryOf = (html) => html.match(/--primary:\s*(#[0-9a-fA-F]+)/)?.[1];

test('parsePlan: 能从说明文字里取出 JSON', () => {
  const raw = '好的，方案如下：\n{"title":"记账本","summary":"记录收支","features":["a","b"],"design":"简洁","data":"账单"}\n祝顺利';
  const p = parsePlan(raw);
  assert.equal(p.title, '记账本');
  assert.equal(p.summary, '记录收支');
  assert.deepEqual(p.features, ['a', 'b']);
  assert.equal(p.design, '简洁');
  assert.equal(p.data, '账单');
});

test('parsePlan: 非法 JSON / 无 JSON 返回 null', () => {
  assert.equal(parsePlan('{title: oops'), null);
  assert.equal(parsePlan('{not json}'), null);
  assert.equal(parsePlan('完全没有 JSON'), null);
});

test('parsePlan: 缺 features 或 title 返回 null', () => {
  assert.equal(parsePlan('{"title":"x","summary":"y"}'), null);
  assert.equal(parsePlan('{"title":"x","features":"notarray"}'), null);
  assert.equal(parsePlan('{"features":["a"]}'), null);
});

test('parsePlan: 截断过长标题与多余功能', () => {
  const p = parsePlan(JSON.stringify({ title: 'T'.repeat(100), features: Array.from({ length: 12 }, (_, i) => i) }));
  assert.equal(p.title.length, 40);
  assert.equal(p.features.length, 8);
  assert.equal(p.features[0], '0');
});

test('pickTemplate: 关键词路由', () => {
  assert.equal(pickTemplate('做一个项目看板').file, 'kanban.html');
  assert.equal(pickTemplate('帮我做个人主页').file, 'homepage.html');
  assert.equal(pickTemplate('房贷计算器').file, 'calculator.html');
  assert.equal(pickTemplate('随便来点什么').file, 'kanban.html'); // 默认
});

test('mockPlan: summary 带上原始需求', () => {
  const p = mockPlan('房贷计算器');
  assert.equal(p.title, '房贷计算器');
  assert.match(p.summary, /房贷计算器/);
});

test('mockCreate: 替换 {{TITLE}}（并转义）', () => {
  const html = mockCreate('做一个项目看板', { title: '我的<看板>' }, 0);
  assert.ok(!html.includes('{{TITLE}}'));
  assert.ok(html.includes('我的&lt;看板&gt;'));
  assert.ok(!html.includes('我的<看板>'));
});

test('mockCreate: 不同 variant 主色不同', () => {
  const a = primaryOf(mockCreate('项目看板', { title: 'x' }, 0));
  const b = primaryOf(mockCreate('项目看板', { title: 'x' }, 1));
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('mockCreate: 三个模板输出都通过静态检查 (>=8)', () => {
  for (const prompt of ['项目看板', '个人主页', '房贷计算器']) {
    const r = staticCheck(mockCreate(prompt, null, 0));
    assert.ok(r.score >= 8, `${prompt}: ${r.score} ${r.issues}`);
  }
});

test('mockEdit: “换成蓝色” 改主色为 #2563eb 且保持 </html> 结尾', () => {
  const base = mockCreate('项目看板', { title: 'x' }, 0);
  const out = mockEdit(base, '主色换成蓝色');
  assert.equal(primaryOf(out), '#2563eb');
  assert.match(out, /<\/html>\s*$/);
  assert.match(out, /mock edit/);
  assert.notEqual(out, base);
});

test('mockEdit: 无颜色词不改主色；暗色会注入样式', () => {
  const base = mockCreate('项目看板', { title: 'x' }, 2);
  const out = mockEdit(base, '加一个按钮');
  assert.equal(primaryOf(out), primaryOf(base));
  const dark = mockEdit(base, '改成暗色');
  assert.match(dark, /background:#0f172a/);
  assert.match(dark, /<\/html>\s*$/);
});
