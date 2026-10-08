// 代码审查（2026-10-09）发现问题的回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { streamChat, streamChatWithRetry, LlmError } from '../server/llm.js';
import { createKvSync } from '../public/js/sandbox.js';

async function boot() {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const { app } = await createApp({ db, cfg: { mockOnly: true, models: [], plannerModel: '', baseUrl: '', apiKey: '' } });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const user = async (name) => (await call('POST', '/api/users', { name })).json.token;
  const idle = async (pid, token) => {
    for (let i = 0; i < 120; i++) {
      const d = (await call('GET', `/api/projects/${pid}`, null, token)).json;
      if (!d.activeJobId) return d;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('job did not finish');
  };
  return { db, server, base, call, user, idle, close: async () => (server.close(), db.close()) };
}

test('同一项目并发发起两次修改：只有一个成功，另一个 409', async () => {
  const t = await boot();
  try {
    const token = await t.user('a');
    const pid = (await t.call('POST', '/api/projects', { prompt: '做一个看板', models: ['mock'] }, token)).json.project.id;
    await t.idle(pid, token);
    const [r1, r2] = await Promise.all([
      t.call('POST', `/api/projects/${pid}/messages`, { text: '改成蓝色' }, token),
      t.call('POST', `/api/projects/${pid}/messages`, { text: '改成绿色' }, token),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    await t.idle(pid, token);
  } finally {
    await t.close();
  }
});

test('并发采用同一个候选：只生成一个版本，版本号不重复', async () => {
  const t = await boot();
  try {
    const token = await t.user('b');
    const pid = (await t.call('POST', '/api/projects', { prompt: '做一个看板', models: ['mock', 'mock'] }, token)).json.project.id;
    const d = await t.idle(pid, token);
    const entry = d.races[0].entries.find((e) => e.status === 'done');
    const rs = await Promise.all([1, 2, 3].map(() => t.call('POST', `/api/race-entries/${entry.id}/adopt`, null, token)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    const seqs = (await t.call('GET', `/api/projects/${pid}`, null, token)).json.versions.map((v) => v.seq);
    assert.deepEqual(seqs, [1]);
  } finally {
    await t.close();
  }
});

test('事件流只允许任务所属用户订阅', async () => {
  const t = await boot();
  try {
    const a = await t.user('a');
    const b = await t.user('b');
    const r = await t.call('POST', '/api/projects', { prompt: '做一个看板', models: ['mock'] }, a);
    const res = await fetch(`${t.base}/api/jobs/${r.json.jobId}/events`, { headers: { Authorization: `Bearer ${b}` } });
    assert.equal(res.status, 404);
    await t.idle(r.json.project.id, a);
  } finally {
    await t.close();
  }
});

test('KV 批量写入要么全部成功，要么全部不写；更新已有键不算新增', async () => {
  const t = await boot();
  try {
    const token = await t.user('c');
    const pid = (await t.call('POST', '/api/projects', { prompt: '做一个看板', models: ['mock'] }, token)).json.project.id;
    await t.idle(pid, token);
    const big = await t.call('POST', `/api/projects/${pid}/kv`, { set: { ok: '1', huge: 'x'.repeat(200_001) } }, token);
    assert.equal(big.status, 413);
    assert.deepEqual((await t.call('GET', `/api/projects/${pid}/kv`, null, token)).json.data, {});
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, '1']));
    assert.equal((await t.call('POST', `/api/projects/${pid}/kv`, { set: many }, token)).status, 200);
    assert.equal((await t.call('POST', `/api/projects/${pid}/kv`, { set: { k0: '2' } }, token)).status, 200);
    assert.equal((await t.call('POST', `/api/projects/${pid}/kv`, { set: { new1: '1' } }, token)).status, 413);
    assert.equal((await t.call('POST', `/api/projects/${pid}/kv`, { set: { new1: '1' }, del: ['k1'] }, token)).status, 200);
  } finally {
    await t.close();
  }
});

test('删除生成中的项目：后台任务停下后不再留下孤儿记录', async () => {
  const t = await boot();
  try {
    const token = await t.user('d');
    const pid = (await t.call('POST', '/api/projects', { prompt: '做一个看板', models: ['mock', 'mock'] }, token)).json.project.id;
    assert.equal((await t.call('DELETE', `/api/projects/${pid}`, null, token)).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    for (const table of ['messages', 'versions', 'races']) {
      const row = await t.db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = $1`, [pid]);
      assert.equal(Number(row.c), 0, table);
    }
  } finally {
    await t.close();
  }
});

test('版本 HTML 接口返回所属项目，预览页用它读写数据', async () => {
  const t = await boot();
  try {
    const token = await t.user('e');
    const pid = (await t.call('POST', '/api/projects', { prompt: '做一个看板', models: ['mock'] }, token)).json.project.id;
    const d = await t.idle(pid, token);
    const v = (await t.call('GET', `/api/versions/${d.versions[0].id}/html`, null, token)).json;
    assert.equal(v.projectId, pid);
  } finally {
    await t.close();
  }
});

// ---------- 模型客户端 ----------
async function fakeLlm(handler) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => handler(res, calls));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', models: ['m'], plannerModel: 'm', mockOnly: false };
  return { cfg, calls: () => calls, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

test('流的最后一行没有换行符也能正确结束', async () => {
  const f = await fakeLlm((res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '！' }, finish_reason: 'stop' }] })}`);
  });
  try {
    assert.equal(await streamChat({ cfg: f.cfg, model: 'm', messages: [] }), '你好！');
  } finally {
    await f.close();
  }
});

test('重试退避期间取消：立即结束，不再发起第二次请求', async () => {
  const f = await fakeLlm((res) => {
    res.writeHead(503);
    res.end('busy');
  });
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const t0 = Date.now();
    await assert.rejects(streamChatWithRetry({ cfg: f.cfg, model: 'm', messages: [], signal: ctrl.signal }), LlmError);
    assert.ok(Date.now() - t0 < 1200);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

// ---------- 预览数据同步队列 ----------
test('KV 同步：失败重试且不丢数据，期间的新变更不被旧值覆盖，写入串行', async () => {
  const saved = [];
  let fail = 1;
  let inflight = 0;
  let maxInflight = 0;
  const sync = createKvSync(
    async (body) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight -= 1;
      if (fail-- > 0) throw new Error('offline');
      saved.push(body);
    },
    { delays: [30] },
  );
  sync.push({ a: '1' });
  sync.push({ a: '2', b: '1' }); // 第一批还没写完时又来了新值
  await new Promise((r) => setTimeout(r, 300));
  const final = Object.assign({}, ...saved.map((b) => b.set));
  assert.deepEqual(final, { a: '2', b: '1' });
  assert.equal(sync.size, 0);
  assert.equal(maxInflight, 1);
});

test('缺失的静态资源返回 404，页面路由仍回落到首页', async () => {
  const t = await boot();
  try {
    const img = await fetch(`${t.base}/img/not-exist.webp`);
    assert.equal(img.status, 404);
    const ok = await fetch(`${t.base}/img/agent-mike.webp`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/webp/);
    const page = await fetch(`${t.base}/p/whatever`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
  } finally {
    await t.close();
  }
});

test('similarText：按行比较页面文字，容忍少量动态内容', async () => {
  const { similarText } = await import('../public/js/sandbox.js');
  assert.equal(similarText('a\nb\nc', 'a\nb\nc'), 1);
  assert.equal(similarText('', ''), 1);
  assert.ok(similarText('标题\n已喝 0 ml\n按钮', '标题\n已喝 250 ml\n按钮') < 0.98);
  assert.ok(similarText('a\nb\nc\nd', 'a\nb\nc\nd\n12:00:01') < 1);
});
