import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ModelHealth } from '../server/model-health.js';
import { planProject, plannerCandidates } from '../server/agents.js';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';

test('健康度排序：成功又快的靠前，连续失败的暂时排到最后，冷却后恢复', () => {
  let t = 0;
  const h = new ModelHealth(() => t);
  const models = ['slow', 'fast', 'broken'];
  h.record('slow', { ok: true, ms: 150_000 });
  h.record('fast', { ok: true, ms: 20_000 });
  h.record('broken', { ok: false, ms: 60_000 });
  h.record('broken', { ok: false, ms: 60_000 });
  assert.deepEqual(h.rank(models), ['fast', 'slow', 'broken']);
  t = 21 * 60_000; // 冷却期过后不再强制垫底
  assert.ok(h.score('broken') > -500);
  // 配置顺序在同分时保持不变
  assert.deepEqual(new ModelHealth().rank(['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('Mike 规划：首选模型失败时自动换下一个模型，并记入健康度', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      if (j.model === 'down') {
        res.writeHead(400);
        return res.end('bad');
      }
      const plan = JSON.stringify({ title: '记账本', summary: 's', features: ['记账'], design: 'd', data: 'n' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: plan } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const health = new ModelHealth();
    const cfg = {
      mockOnly: false,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'k',
      models: ['down', 'up'],
      plannerModel: 'down',
      health,
    };
    assert.deepEqual(plannerCandidates(cfg), ['down', 'up']);
    const plan = await planProject({ cfg, prompt: '做一个记账本' });
    assert.equal(plan.source, 'up');
    assert.equal(plan.title, '记账本');
    assert.equal(health.get('down').streak, 1);
    // 再失败一次后，down 进入冷却，候选顺序变为 up 优先
    health.record('down', { ok: false, ms: 1 });
    assert.deepEqual(plannerCandidates(cfg), ['up', 'down']);
  } finally {
    server.close();
  }
});

test('模型清单随隧道地址一起上报：线上配置更新并持久化，默认赛马阵容来自健康度排序', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const cfg = {
    mockOnly: false,
    models: ['a'],
    plannerModel: 'a',
    baseUrl: 'https://old.trycloudflare.com/v1',
    apiKey: 'gateway-token-123',
  };
  const { app } = await createApp({ db, cfg });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/admin/llm-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ baseUrl: 'https://x-y.trycloudflare.com/v1', models: ['m1', 'm2', 'bad name!', 'm3', 'm4'] }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(cfg.models, ['m1', 'm2', 'm3', 'm4']);
    assert.equal(cfg.plannerModel, 'm1');
    const conf = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(conf.defaultRace, ['m1', 'm2', 'm3']);
    cfg.health.record('m1', { ok: false, ms: 1 });
    cfg.health.record('m1', { ok: false, ms: 1 });
    const conf2 = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(conf2.defaultRace, ['m2', 'm3', 'm4']);
  } finally {
    server.close();
  }
  // 重启后从数据库恢复模型清单
  const cfg2 = {
    mockOnly: false,
    models: ['a'],
    plannerModel: 'a',
    baseUrl: 'https://old.trycloudflare.com/v1',
    apiKey: 'gateway-token-123',
  };
  const again = await createApp({ db, cfg: cfg2 });
  assert.ok(again.app);
  assert.deepEqual(cfg2.models, ['m1', 'm2', 'm3', 'm4']);
  await db.close();
});

test('质量先验：同样健康时优先 claude、gemini，gpt-oss 排后；连续失败仍然垫底', () => {
  const h = new ModelHealth();
  const models = ['gpt-oss-120b-medium', 'grok-4.7-build-fast', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'];
  assert.deepEqual(h.rank(models).slice(0, 2), ['claude-sonnet-4-6', 'gemini-3.8-flash-high']);
  assert.equal(h.rank(models).at(-1), 'gpt-oss-120b-medium');
  // 慢但可靠的高质量模型不会因为耗时被挤出前三
  h.record('claude-sonnet-4-6', { ok: true, ms: 200_000 });
  h.record('gpt-oss-120b-medium', { ok: true, ms: 60_000 });
  assert.ok(h.rank(models).slice(0, 3).includes('claude-sonnet-4-6'));
  h.record('claude-sonnet-4-6', { ok: false, ms: 1 });
  h.record('claude-sonnet-4-6', { ok: false, ms: 1 });
  assert.equal(h.rank(models).at(-1), 'claude-sonnet-4-6');
});
