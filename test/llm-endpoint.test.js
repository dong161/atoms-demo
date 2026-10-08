import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';

async function boot(db, cfg) {
  const { app } = await createApp({ db, cfg });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, token, body) => fetch(`${base}/api/admin/llm-endpoint`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

test('模型地址上报：需要网关令牌、只接受 trycloudflare 地址，并在重启后生效', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const cfg = { mockOnly: false, models: ['m'], plannerModel: 'm', baseUrl: 'https://old.trycloudflare.com/v1', apiKey: 'gateway-token-123' };
  const { server, base } = await boot(db, cfg);
  try {
    assert.equal((await post(base, '', { baseUrl: 'https://a-b.trycloudflare.com/v1' })).status, 401);
    assert.equal((await post(base, 'wrong-token-1234', { baseUrl: 'https://a-b.trycloudflare.com/v1' })).status, 401);
    assert.equal((await post(base, cfg.apiKey, { baseUrl: 'https://evil.example.com/v1' })).status, 400);
    assert.equal((await post(base, cfg.apiKey, { baseUrl: 'https://new-tunnel.trycloudflare.com/v1' })).status, 200);
    assert.equal(cfg.baseUrl, 'https://new-tunnel.trycloudflare.com/v1');
  } finally { server.close(); }
  // 模拟进程重启：新配置从数据库恢复上报过的地址
  const cfg2 = { ...cfg, baseUrl: 'https://old.trycloudflare.com/v1' };
  const again = await boot(db, cfg2);
  again.server.close();
  assert.equal(cfg2.baseUrl, 'https://new-tunnel.trycloudflare.com/v1');
  await db.close();
});
