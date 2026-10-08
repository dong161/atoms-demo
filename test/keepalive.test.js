import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkHealth, runKeepalive } from '../scripts/keepalive.mjs';
async function fixture(handler, fn) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${s.address().port}`);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
}
test('保活拒绝HTTP200的冷启动HTML，而非误报成功', () =>
  fixture(
    (q, r) => r.end('<html>Render APPLICATION LOADING</html>'),
    async (url) => {
      await assert.rejects(() => checkHealth(url), /非JSON/);
      assert.equal(await runKeepalive({ url, attempts: 1, delayMs: 0, log: () => {} }), 1);
    },
  ));
test('保活拒绝非200和异常数据库状态', async () => {
  await fixture(
    (q, r) => {
      r.statusCode = 503;
      r.end('unavailable');
    },
    (url) => assert.rejects(() => checkHealth(url), /503/),
  );
  await fixture(
    (q, r) => r.end(JSON.stringify({ ok: true, db: 'sqlite' })),
    (url) => assert.rejects(() => checkHealth(url), /postgres/),
  );
});
test('保活暂时失败后重试，并输出已上线提交', () => {
  let hits = 0;
  return fixture(
    (q, r) => {
      if (++hits === 1) {
        r.statusCode = 503;
        r.end('warming');
      } else r.end(JSON.stringify({ ok: true, db: 'postgres', mock: false, commit: 'fixture' }));
    },
    async (url) => {
      const logs = [];
      assert.equal(await runKeepalive({ url, delayMs: 0, log: (x) => logs.push(JSON.parse(x)) }), 0);
      assert.equal(hits, 2);
      assert.equal(logs[1].commit, 'fixture');
      assert.equal(logs[1].attempt, 2);
    },
  );
});
test('保活请求具有超时上限', () =>
  fixture(
    (q, r) => {},
    (url) => assert.rejects(() => checkHealth(url, { timeoutMs: 20 }), /timeout|aborted/i),
  ));
