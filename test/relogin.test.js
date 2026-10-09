import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { validateAttachments } from '../public/js/generation-presets.js';

const CID = 'test-client.apps.googleusercontent.com';
const people = {
  'cred-a': { sub: 'ga', email: 'a@gmail.com', name: 'A' },
  'cred-b': { sub: 'gb', email: 'b@gmail.com', name: 'B' },
};

async function boot() {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const { app } = await createApp({
    db,
    cfg: { mockOnly: true, models: [], plannerModel: '', baseUrl: '', apiKey: '' },
    googleClientId: CID,
    verifyGoogle: async (c) => {
      if (!people[c]) throw Object.assign(new Error('Google 凭证无效或已过期'), { status: 401 });
      return people[c];
    },
  });
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
    return { status: res.status, json: await res.json() };
  };
  return { db, server, post: (p, b, t) => call('POST', p, b, t), get: (p, t) => call('GET', p, null, t) };
}
const projectIds = async (t, token) => (await t.get('/api/projects', token)).json.projects.map((p) => p.id);

test('退出后重新登录能找回项目：邮箱、Google、恢复码三种方式', async () => {
  const t = await boot();
  try {
    // 邮箱
    const reg = await t.post('/api/auth/register', { name: '甲', email: 'jia@example.com', password: 'password-123456' });
    const p1 = (await t.post('/api/projects', { prompt: '做一个记账本', models: ['mock'] }, reg.json.token)).json.project.id;
    const login = await t.post('/api/auth/login', { email: 'JIA@example.com', password: 'password-123456' });
    assert.notEqual(login.json.token, reg.json.token);
    assert.deepEqual(await projectIds(t, login.json.token), [p1]);
    // Google
    const g1 = await t.post('/api/auth/google', { credential: 'cred-a' });
    const p2 = (await t.post('/api/projects', { prompt: '做一个打卡', models: ['mock'] }, g1.json.token)).json.project.id;
    const g2 = await t.post('/api/auth/google', { credential: 'cred-a' });
    assert.deepEqual(await projectIds(t, g2.json.token), [p2]);
    assert.equal((await t.get('/api/me', g2.json.token)).json.user.google, true);
    // 昵称 + 恢复码
    const guest = await t.post('/api/users', { name: '乙' });
    const p3 = (await t.post('/api/projects', { prompt: '做一个番茄钟', models: ['mock'] }, guest.json.token)).json.project.id;
    assert.deepEqual(await projectIds(t, guest.json.token), [p3]);
  } finally {
    t.server.close();
    await t.db.close();
  }
});

test('昵称账号补绑邮箱或 Google：账号不变，之后直接登录就能看到原来的项目', async () => {
  const t = await boot();
  try {
    const g = await t.post('/api/users', { name: '丙' });
    const pid = (await t.post('/api/projects', { prompt: '做一个看板', models: ['mock'] }, g.json.token)).json.project.id;
    const me = (await t.get('/api/me', g.json.token)).json.user;
    assert.equal(me.email, null);
    assert.equal(me.google, false);
    assert.equal(me.google_sub, undefined);

    const bad = await t.post('/api/auth/bind-email', { email: 'x', password: 'password-123456' }, g.json.token);
    assert.equal(bad.status, 400);
    const ok = await t.post('/api/auth/bind-email', { email: 'Bing@Example.com', password: 'password-123456' }, g.json.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.email, 'bing@example.com');
    // 已绑定后不能再绑
    assert.equal((await t.post('/api/auth/bind-google', { credential: 'cred-b' }, g.json.token)).status, 409);
    const login = await t.post('/api/auth/login', { email: 'bing@example.com', password: 'password-123456' });
    assert.equal(login.json.user.id, g.json.user.id);
    assert.deepEqual(await projectIds(t, login.json.token), [pid]);

    // 另一个昵称账号绑 Google；邮箱已被占用时拒绝
    const h = await t.post('/api/users', { name: '丁' });
    const hp = (await t.post('/api/projects', { prompt: '做一个日记', models: ['mock'] }, h.json.token)).json.project.id;
    const dup = await t.post('/api/auth/bind-email', { email: 'bing@example.com', password: 'password-123456' }, h.json.token);
    assert.equal(dup.status, 409);
    // 无效凭证返回 400 而不是 401（401 会让前端以为登录失效）
    assert.equal((await t.post('/api/auth/bind-google', { credential: 'nope' }, h.json.token)).status, 400);
    const bg = await t.post('/api/auth/bind-google', { credential: 'cred-b' }, h.json.token);
    assert.equal(bg.status, 200);
    const viaGoogle = await t.post('/api/auth/google', { credential: 'cred-b' });
    assert.equal(viaGoogle.json.user.id, h.json.user.id);
    assert.equal(viaGoogle.json.created, false);
    assert.deepEqual(await projectIds(t, viaGoogle.json.token), [hp]);
    // 已在本站注册过的 Google 账号不能再绑到别的昵称账号
    await t.post('/api/auth/google', { credential: 'cred-a' });
    const k = await t.post('/api/users', { name: '戊' });
    assert.equal((await t.post('/api/auth/bind-google', { credential: 'cred-a' }, k.json.token)).status, 409);
  } finally {
    t.server.close();
    await t.db.close();
  }
});

test('附件上限：单个 3 万字符以内可用，CSV 可用，超出给出明确提示', () => {
  assert.equal(validateAttachments([{ name: 'a.md', text: 'x'.repeat(29_000) }]).length, 1);
  assert.equal(validateAttachments([{ name: 'data.csv', text: 'a,b\n1,2' }]).length, 1);
  assert.throws(() => validateAttachments([{ name: 'a.md', text: 'x'.repeat(30_001) }]), /3 万字符/);
  assert.throws(
    () =>
      validateAttachments([
        { name: 'a.md', text: 'x'.repeat(25_000) },
        { name: 'b.md', text: 'x'.repeat(25_000) },
        { name: 'c.md', text: 'x'.repeat(25_000) },
      ]),
    /6 万字符/,
  );
});
