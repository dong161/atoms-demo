import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openDb } from '../server/db.js';

let server;
let db;
let base;
const cfg = { mockOnly: true, models: [], plannerModel: '', baseUrl: '', apiKey: '' };

before(async () => {
  db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const { app } = await createApp({ db, cfg });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await db.close();
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

async function waitIdle(token, projectId, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const { json } = await call('GET', `/api/projects/${projectId}`, { token });
    if (json.activeJobId === null) return json;
    if (Date.now() - t0 > timeoutMs) throw new Error('job timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const state = {};

test('用户注册与鉴权', async () => {
  const r = await call('POST', '/api/users', { body: { name: '小明' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  state.token = r.json.token;
  assert.equal((await call('POST', '/api/users', { body: { name: '  ' } })).status, 400);
  assert.equal((await call('GET', '/api/projects')).status, 401);
  assert.equal((await call('GET', '/api/projects', { token: 'bogus' })).status, 401);
  const me = await call('GET', '/api/me', { token: state.token });
  assert.equal(me.json.user.name, '小明');
});

test('创建项目 → 双模型赛马 → 评审状态，尚无版本', async () => {
  const { token } = state;
  const r = await call('POST', '/api/projects', { token, body: { prompt: '做一个项目看板', models: ['mock', 'mock'] } });
  assert.equal(r.status, 200);
  assert.ok(r.json.jobId);
  state.pid = r.json.project.id;
  const d = await waitIdle(token, state.pid);
  assert.equal(d.races.length, 1);
  const race = d.races[0];
  assert.equal(race.status, 'review');
  assert.equal(race.entries.length, 2);
  assert.ok(race.entries.every((e) => e.status === 'done' && e.size > 1000));
  assert.equal(d.versions.length, 0);
  assert.equal(d.project.current_version_id, null);
  assert.ok(d.project.plan?.title);
  state.entries = race.entries.map((e) => e.id);
});

test('打分并采用 → Version 1', async () => {
  const { token, pid, entries } = state;
  const s = await call('POST', `/api/race-entries/${entries[0]}/score`, { token, body: { score: 88, detail: { ok: true } } });
  assert.equal(s.json.score, 88);
  const a = await call('POST', `/api/race-entries/${entries[0]}/adopt`, { token });
  assert.equal(a.status, 200);
  assert.equal(a.json.version.seq, 1);
  state.v1 = a.json.version.id;
  const d = (await call('GET', `/api/projects/${pid}`, { token })).json;
  assert.equal(d.project.current_version_id, state.v1);
  assert.equal(d.versions.length, 1);
  assert.equal(d.versions[0].score, 88);
  assert.equal(d.races[0].status, 'adopted');
  const kinds = new Set(d.messages.map((m) => m.kind));
  for (const k of ['text', 'plan', 'race', 'version']) assert.ok(kinds.has(k), `missing kind ${k}`);
  const roles = new Set(d.messages.map((m) => m.role));
  for (const r of ['user', 'mike', 'alex']) assert.ok(roles.has(r), `missing role ${r}`);
  // 重复采用同一候选应失败
  assert.equal((await call('POST', `/api/race-entries/${entries[0]}/adopt`, { token })).status, 409);
});

test('单模型修改自动采用 → Version 2 含蓝色主色', async () => {
  const { token, pid } = state;
  const r = await call('POST', `/api/projects/${pid}/messages`, { token, body: { text: '主色换成蓝色' } });
  assert.equal(r.status, 200);
  const d = await waitIdle(token, pid);
  assert.equal(d.versions.length, 2);
  assert.equal(d.versions[0].seq, 2);
  state.v2 = d.versions[0].id;
  assert.equal(d.project.current_version_id, state.v2);
  const h = await call('GET', `/api/versions/${state.v2}/html`, { token });
  assert.match(h.json.html, /--primary:\s*#2563eb/);
  assert.equal(h.json.seq, 2);
});

test('回退 → Version 3', async () => {
  const { token, pid, v1 } = state;
  const r = await call('POST', `/api/versions/${v1}/restore`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.version.seq, 3);
  const d = (await call('GET', `/api/projects/${pid}`, { token })).json;
  assert.equal(d.project.current_version_id, r.json.version.id);
  const h = await call('GET', `/api/versions/${r.json.version.id}/html`, { token });
  assert.doesNotMatch(h.json.html, /--primary:\s*#2563eb/);
});

test('发布、公开访问分享页、kv 隔离', async () => {
  const { token, pid } = state;
  const p = await call('POST', `/api/projects/${pid}/publish`, { token });
  assert.equal(p.status, 200);
  assert.ok(p.json.slug);
  assert.equal(p.json.seq, 3);
  const slug = p.json.slug;
  // 再次发布 slug 不变
  assert.equal((await call('POST', `/api/projects/${pid}/publish`, { token })).json.slug, slug);

  const s = await call('GET', `/api/share/${slug}`);
  assert.equal(s.status, 200);
  assert.match(s.json.html, /<\/html>\s*$/);
  assert.equal((await call('GET', '/api/share/nope')).status, 404);

  const v = 'abcdefgh12';
  const w = await call('POST', `/api/share/${slug}/kv?visitor=${v}`, { body: { set: { todo: '[1,2]', n: 5 } } });
  assert.equal(w.status, 200);
  const r = await call('GET', `/api/share/${slug}/kv?visitor=${v}`);
  assert.deepEqual(r.json.data, { todo: '[1,2]', n: '5' });
  // 另一个访客看不到
  const other = await call('GET', `/api/share/${slug}/kv?visitor=zzzzzzzz99`);
  assert.deepEqual(other.json.data, {});
  // 无效 visitor
  assert.equal((await call('GET', `/api/share/${slug}/kv?visitor=short`)).status, 404);
  // owner kv 不受访客写入影响
  assert.deepEqual((await call('GET', `/api/projects/${pid}/kv`, { token })).json.data, {});
  await call('POST', `/api/projects/${pid}/kv`, { token, body: { set: { own: 'x' } } });
  assert.deepEqual((await call('GET', `/api/projects/${pid}/kv`, { token })).json.data, { own: 'x' });
  assert.deepEqual((await call('GET', `/api/share/${slug}/kv?visitor=${v}`)).json.data, { todo: '[1,2]', n: '5' });
  // 删除键
  await call('POST', `/api/share/${slug}/kv?visitor=${v}`, { body: { del: ['todo'] } });
  assert.deepEqual((await call('GET', `/api/share/${slug}/kv?visitor=${v}`)).json.data, { n: '5' });
});

test('其他用户无法访问别人的项目', async () => {
  const u2 = (await call('POST', '/api/users', { body: { name: '小红' } })).json.token;
  assert.equal((await call('GET', `/api/projects/${state.pid}`, { token: u2 })).status, 404);
  assert.equal((await call('POST', `/api/projects/${state.pid}/publish`, { token: u2 })).status, 404);
  assert.equal((await call('GET', `/api/versions/${state.v1}/html`, { token: u2 })).status, 404);
  assert.equal((await call('POST', `/api/race-entries/${state.entries[1]}/adopt`, { token: u2 })).status, 404);
  assert.deepEqual((await call('GET', '/api/projects', { token: u2 })).json.projects, []);
});

test('SSE 事件流：text/event-stream，最终出现 end 事件', async () => {
  const { token } = state;
  const r = await call('POST', '/api/projects', { token, body: { prompt: '做一个房贷计算器', models: ['mock'] } });
  const { jobId } = r.json;
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/jobs/${jobId}/events?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  const deadline = setTimeout(() => ctrl.abort(), 15_000);
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        if (block.startsWith('data:')) events.push(JSON.parse(block.slice(5)));
      }
    }
  } finally { clearTimeout(deadline); }
  const types = events.map((e) => e.type);
  assert.ok(types.includes('status'));
  assert.ok(types.includes('adopted'));
  assert.equal(types.at(-1), 'end');
  assert.equal(events.at(-1).status, 'done');
  // 未鉴权不可订阅
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/events`)).status, 401);
  await waitIdle(token, r.json.project.id);
});
