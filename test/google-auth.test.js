import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdToken } from '../server/google-auth.js';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';

const CID = 'test-client.apps.googleusercontent.com';
const fakeFetch =
  (info, ok = true) =>
  async () => ({ ok, json: async () => info });
const good = {
  aud: CID,
  iss: 'https://accounts.google.com',
  exp: String(Math.floor(Date.now() / 1000) + 600),
  email_verified: 'true',
  sub: '123',
  email: 'A@Gmail.com',
  name: '小明',
};

test('Google 凭证校验：aud、签发方、过期、邮箱验证都要核对', async () => {
  const token = 'x'.repeat(40);
  const ok = await verifyGoogleIdToken(token, CID, { fetchImpl: fakeFetch(good) });
  assert.deepEqual(ok, { sub: '123', email: 'a@gmail.com', name: '小明' });
  await assert.rejects(verifyGoogleIdToken(token, CID, { fetchImpl: fakeFetch({ ...good, aud: 'other' }) }), /不是发给本站/);
  await assert.rejects(verifyGoogleIdToken(token, CID, { fetchImpl: fakeFetch({ ...good, iss: 'evil.com' }) }), /签发方/);
  await assert.rejects(verifyGoogleIdToken(token, CID, { fetchImpl: fakeFetch({ ...good, exp: '1' }) }), /过期/);
  await assert.rejects(verifyGoogleIdToken(token, CID, { fetchImpl: fakeFetch({ ...good, email_verified: 'false' }) }), /未验证/);
  await assert.rejects(verifyGoogleIdToken(token, CID, { fetchImpl: fakeFetch({}, false) }), /无效/);
  await assert.rejects(verifyGoogleIdToken('short', CID, { fetchImpl: fakeFetch(good) }), /格式/);
  await assert.rejects(verifyGoogleIdToken(token, '', { fetchImpl: fakeFetch(good) }), /未配置/);
});

async function boot(opts) {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const { app } = await createApp({ db, cfg: { mockOnly: true, models: [], plannerModel: '', baseUrl: '', apiKey: '' }, ...opts });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const get = async (path, token) => (await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).json();
  return { db, server, post, get, base };
}

test('Google 登录：新用户自动创建，再次登录是同一账号，同邮箱的已有账号自动关联', async () => {
  const people = {
    'cred-new': { sub: 'g1', email: 'new@gmail.com', name: '新用户' },
    'cred-old': { sub: 'g2', email: 'old@example.com', name: 'X' },
  };
  const t = await boot({ googleClientId: CID, verifyGoogle: async (c) => people[c] });
  try {
    assert.equal((await t.get('/api/config')).googleClientId, CID);
    const a = await t.post('/api/auth/google', { credential: 'cred-new' });
    assert.equal(a.status, 200);
    assert.equal(a.json.user.name, '新用户');
    assert.equal(a.json.created, true);
    assert.equal((await t.get('/api/me', a.json.token)).user.id, a.json.user.id);
    const again = await t.post('/api/auth/google', { credential: 'cred-new' });
    assert.equal(again.json.user.id, a.json.user.id);
    assert.equal(again.json.created, false);
    // 已有邮箱密码账号 → Google 登录关联到它，原项目仍可见
    const reg = await t.post('/api/auth/register', { name: '老用户', email: 'old@example.com', password: 'password-123456' });
    const proj = await t.post('/api/projects', { prompt: '做一个看板', models: ['mock'] }, reg.json.token);
    const g = await t.post('/api/auth/google', { credential: 'cred-old' });
    assert.equal(g.json.user.id, reg.json.user.id);
    const list = await t.get('/api/projects', g.json.token);
    assert.ok(list.projects.some((p) => p.id === proj.json.project.id));
  } finally {
    t.server.close();
    await t.db.close();
  }
});

test('未配置 Google 客户端 ID 时不开放 Google 登录', async () => {
  const t = await boot({ googleClientId: '' });
  try {
    assert.equal((await t.get('/api/config')).googleClientId, null);
    assert.equal((await t.post('/api/auth/google', { credential: 'x'.repeat(40) })).status, 501);
  } finally {
    t.server.close();
    await t.db.close();
  }
});
