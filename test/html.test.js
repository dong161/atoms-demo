import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml, staticCheck, titleFromHtml } from '../server/html.js';

const FULL = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>测试应用</title><style>body{margin:0}</style></head>
<body><div id="app">hello</div><script>document.getElementById('app').textContent='ok';
${'// padding\n'.repeat(200)}</script></body></html>`;

test('extractHtml: 空输入返回空串', () => {
  assert.equal(extractHtml(''), '');
  assert.equal(extractHtml(null), '');
});

test('extractHtml: 去掉 ```html 围栏', () => {
  const out = extractHtml('```html\n' + FULL + '\n```');
  assert.equal(out, FULL.trim());
});

test('extractHtml: 去掉前置说明文字', () => {
  const out = extractHtml('好的，这是你要的页面：\n\n' + FULL);
  assert.ok(out.startsWith('<!DOCTYPE html>'));
  assert.ok(out.endsWith('</html>'));
});

test('extractHtml: 去掉 </html> 之后的说明文字', () => {
  const out = extractHtml(FULL + '\n\n以上就是全部代码，希望有帮助！');
  assert.ok(out.endsWith('</html>'));
  assert.ok(!out.includes('希望有帮助'));
});

test('extractHtml: 围栏 + 前后文字同时存在', () => {
  const out = extractHtml('前言\n```html\n' + FULL + '\n```\n后记');
  assert.equal(out, FULL.trim());
});

test('extractHtml: 裸片段会被包成完整文档', () => {
  const out = extractHtml('<div id="x">hi</div><script>1</script>');
  assert.match(out, /^<!DOCTYPE html>/);
  assert.match(out, /<html lang="zh-CN">/);
  assert.match(out, /name="viewport"/);
  assert.match(out, /<div id="x">hi<\/div>/);
  assert.match(out, /<\/html>$/);
});

test('extractHtml: 无 HTML 的纯文字原样返回', () => {
  assert.equal(extractHtml('抱歉，我做不到'), '抱歉，我做不到');
});

test('staticCheck: 完整文档得高分', () => {
  const r = staticCheck(FULL);
  assert.equal(r.score, 10);
  assert.deepEqual(r.issues, []);
});

test('staticCheck: 被截断的文档扣分', () => {
  const r = staticCheck(FULL.replace(/<\/html>\s*$/, ''));
  assert.equal(r.score, 7);
  assert.ok(r.issues.some((s) => s.includes('不完整')));
});

test('staticCheck: 没有脚本扣分', () => {
  const html = FULL.replace(/<script[\s\S]*<\/script>/, '<p>' + 'x'.repeat(2000) + '</p>');
  const r = staticCheck(html);
  assert.equal(r.score, 7);
  assert.ok(r.issues.some((s) => s.includes('没有脚本')));
});

test('staticCheck: 缺 viewport 扣分', () => {
  const r = staticCheck(FULL.replace(/<meta name="viewport"[^>]*>/, ''));
  assert.equal(r.score, 8);
  assert.ok(r.issues.some((s) => s.includes('viewport')));
});

test('staticCheck: 空内容分数不会为负', () => {
  const r = staticCheck('');
  assert.ok(r.score >= 0);
  assert.ok(r.issues.length >= 4);
});

test('titleFromHtml: 取 <title>，缺失时用兜底', () => {
  assert.equal(titleFromHtml(FULL), '测试应用');
  assert.equal(titleFromHtml('<html></html>'), '未命名应用');
  assert.equal(titleFromHtml('<html></html>', 'X'), 'X');
  assert.equal(titleFromHtml('<title>  空格  </title>'), '空格');
});
