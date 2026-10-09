import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportHtml } from '../public/js/sandbox.js';

test('导出 HTML：无数据时原样导出；有数据时注入只执行一次的数据写入，且不会被数据里的 </script> 截断', () => {
  const html = '<!DOCTYPE html><html><head><title>T</title></head><body><script>1</script></body></html>';
  assert.equal(exportHtml(html, {}), html);
  const out = exportHtml(html, { tasks: '[{"t":"</script><b>x"}]' });
  assert.match(out, /<head>\s*<script>\(function\(\)\{try\{if\(localStorage.getItem\('__atoms_export_seeded'\)\)return;/);
  assert.ok(!out.slice(0, out.indexOf('</head>')).includes('</script><b>'), '数据中的 </script> 必须被转义');
  // 注入脚本可直接执行，把数据写入 localStorage
  const seed = out.match(/<head>\s*<script>([\s\S]*?)<\/script>/)[1];
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  new Function('localStorage', seed)(localStorage);
  assert.equal(store.get('tasks'), '[{"t":"</script><b>x"}]');
  store.set('tasks', 'changed');
  new Function('localStorage', seed)(localStorage);
  assert.equal(store.get('tasks'), 'changed', '再次打开不覆盖用户在导出文件里的修改');
});
