// 避坑指南：断网 / 额度用尽时不能崩。模型服务完全不可用时的兜底行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';

// 找一个当前没有服务监听的端口，模拟模型服务宕机
async function deadPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('模型服务不可用：首轮用演示数据兜底产出可用版本；修改失败时保留当前版本并提示', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const cfg = {
    mockOnly: false,
    baseUrl: `http://127.0.0.1:${await deadPort()}/v1`,
    apiKey: 'k',
    models: ['m1', 'm2'],
    plannerModel: 'm1',
  };
  const { app } = await createApp({ db, cfg });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const idle = async (pid) => {
    for (let i = 0; i < 200; i++) {
      const d = (await call('GET', `/api/projects/${pid}`)).json;
      if (!d.activeJobId) return d;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('job did not finish');
  };
  try {
    token = (await call('POST', '/api/users', { name: '断网' })).json.token;
    const created = await call('POST', '/api/projects', { prompt: '做一个项目看板', models: ['m1', 'm2'] });
    assert.equal(created.status, 200);
    let d = await idle(created.json.project.id);
    // 两路真实模型都失败 → 追加一路演示兜底并自动采用
    const entries = d.races[0].entries;
    assert.equal(entries.filter((e) => e.status === 'failed').length, 2);
    assert.ok(entries.some((e) => e.model === 'mock' && e.status === 'done'));
    assert.equal(d.versions.length, 1);
    assert.equal(d.project.plan.source, 'mock');
    const v1 = d.project.current_version_id;

    // 修改：不能用演示数据冒充修改结果，版本保持不变，并给出可理解的错误消息
    const edit = await call('POST', `/api/projects/${created.json.project.id}/messages`, { text: '主色改成蓝色', models: ['m1'] });
    assert.equal(edit.status, 200);
    d = await idle(created.json.project.id);
    assert.equal(d.project.current_version_id, v1);
    assert.equal(d.versions.length, 1);
    const last = d.messages.at(-1);
    assert.equal(last.kind, 'error');
    assert.match(last.content, /当前版本保持不变/);
  } finally {
    server.close();
    await db.close();
  }
});
