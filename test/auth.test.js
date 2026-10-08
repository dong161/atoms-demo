import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
const cfg = { mockOnly: true, models: [], plannerModel: '', baseUrl: '', apiKey: '' };
async function fixture(fn) {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const { app } = await createApp({ db, cfg });
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const call = async (route, body, token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    await fn(call, db);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await db.close();
  }
}
const account = { name: '测试作者', email: 'Builder@example.test', password: 'test-password-only-42' };
test('邮箱注册、大小写规范化、密码和令牌不存明文', () =>
  fixture(async (call, db) => {
    const r = await call('/api/auth/register', account);
    assert.equal(r.status, 200);
    assert.equal(r.data.user.email, 'builder@example.test');
    assert.equal(r.data.user.password_hash, undefined);
    const row = await db.get('SELECT * FROM users WHERE id=$1', [r.data.user.id]);
    assert.match(row.password_hash, /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.notEqual(row.token, r.data.token);
    assert.equal((await call('/api/me', null, r.data.token)).status, 200);
  }));
test('重复邮箱、无效邮箱、短密码均拒绝', () =>
  fixture(async (call) => {
    assert.equal((await call('/api/auth/register', { ...account, email: 'bad' })).status, 400);
    assert.equal((await call('/api/auth/register', { ...account, password: 'short' })).status, 400);
    assert.equal((await call('/api/auth/register', account)).status, 200);
    assert.equal((await call('/api/auth/register', { ...account, email: 'BUILDER@EXAMPLE.TEST' })).status, 409);
  }));
test('正确密码登录原账号；错误密码与未知邮箱响应一致', () =>
  fixture(async (call, db) => {
    const r = await call('/api/auth/register', account);
    const login = await call('/api/auth/login', { email: 'BUILDER@example.test', password: account.password });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.id, r.data.user.id);
    assert.notEqual(login.data.token, r.data.token);
    const bad = await call('/api/auth/login', { email: account.email, password: 'wrong-password' });
    const missing = await call('/api/auth/login', { email: 'unknown@example.test', password: 'wrong-password' });
    assert.deepEqual(bad, missing);
    assert.equal(bad.status, 401);
    const row = await db.get('SELECT * FROM sessions');
    assert.notEqual(row.token, login.data.token);
    assert.equal((await call('/api/me', null, login.data.token)).status, 200);
    await db.run('UPDATE sessions SET expires_at=$1', [Date.now() - 1]);
    assert.equal((await call('/api/me', null, login.data.token)).status, 401);
    assert.equal((await call('/api/me', null, r.data.token)).status, 200);
  }));
test('旧昵称恢复码继续登录，不泄漏密码字段', () =>
  fixture(async (call) => {
    const r = await call('/api/users', { name: '旧用户' });
    assert.equal(r.status, 200);
    const me = await call('/api/me', null, r.data.token);
    assert.equal(me.status, 200);
    assert.equal(me.data.user.password_hash, undefined);
    assert.equal((await call('/api/auth/login', { email: 'old@example.test', password: account.password })).status, 401);
  }));
test('已有SQLite库迁移可重复启动且旧用户不丢', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atoms-auth-migration-'));
  const file = path.join(dir, 'old.db');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token TEXT NOT NULL UNIQUE,created_at BIGINT NOT NULL)');
  old.prepare('INSERT INTO users VALUES(?,?,?,?)').run('legacy', '旧昵称', crypto.createHash('sha256').update('fixture').digest('hex'), 1);
  old.close();
  try {
    for (let i = 0; i < 2; i++) {
      const db = await openDb({ databaseUrl: '', sqlitePath: file });
      const row = await db.get('SELECT * FROM users WHERE id=$1', ['legacy']);
      assert.equal(row.name, '旧昵称');
      assert.equal(row.email, null);
      assert.equal(row.password_hash, null);
      await db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
