import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { parseTarget, parseErrors, editHint } from '../server/edit-context.js';

test('parseTarget / parseErrors：清洗与限长', () => {
  assert.equal(parseTarget(null), null);
  assert.equal(parseTarget({ selector: '', tag: 'div' }), null);
  const t = parseTarget({
    selector: 'main > button:nth-of-type(2)',
    tag: 'BUTTON<script>',
    text: 'x'.repeat(500),
    html: '<b>'.repeat(500),
  });
  assert.equal(t.tag, 'buttonscript');
  assert.equal(t.text.length, 120);
  assert.equal(t.html.length, 800);
  assert.deepEqual(parseErrors(['a', '', 'b', 'c', 'd', 'e', 'f']), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(parseErrors('oops'), []);
  assert.equal(editHint({ target: null, errors: [] }), '');
  assert.match(editHint({ target: t, errors: ['TypeError: x is undefined'] }), /只修改用户在预览中选中的这个元素[\s\S]*TypeError/);
});

async function boot() {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const { app, hub } = await createApp({ db, cfg: { mockOnly: true, models: [], plannerModel: '', baseUrl: '', apiKey: '' } });
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
  token = (await call('POST', '/api/users', { name: '测试' })).json.token;
  const idle = async (pid) => {
    for (let i = 0; i < 100; i++) {
      const d = (await call('GET', `/api/projects/${pid}`)).json;
      if (!d.activeJobId) return d;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('job did not finish');
  };
  return { db, hub, server, call, idle };
}

test('点选元素修改与一键修复：附加上下文只进模型，不进对话', async () => {
  const { db, server, call, idle } = await boot();
  try {
    const pid = (await call('POST', '/api/projects', { prompt: '做一个项目看板', models: ['mock'] })).json.project.id;
    await idle(pid);
    const target = { selector: 'header > h1', tag: 'h1', text: '项目看板', html: '<h1>项目看板</h1>' };
    const r1 = await call('POST', `/api/projects/${pid}/messages`, { text: '标题改成蓝色', target });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.message.content, '标题改成蓝色');
    assert.deepEqual(r1.json.message.meta.target, { tag: 'h1', text: '项目看板' });
    let d = await idle(pid);
    assert.equal(d.versions.length, 2);
    // 一键修复：不写文字也可以，消息里只显示摘要
    const r2 = await call('POST', `/api/projects/${pid}/messages`, { fixErrors: ['TypeError: a is undefined', 'ReferenceError: b'] });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.message.content, '修复预览中的 2 个运行错误');
    d = await idle(pid);
    const msgs = await db.all('SELECT content FROM messages WHERE project_id = $1', [pid]);
    assert.ok(msgs.every((m) => !m.content.includes('元素片段') && !m.content.includes('TypeError')));
    const races = await db.all('SELECT instruction FROM races WHERE project_id = $1 ORDER BY created_at', [pid]);
    assert.deepEqual(
      races.slice(1).map((r) => r.instruction),
      ['标题改成蓝色', '修复预览中的 2 个运行错误'],
    );
    // 两者都没有时仍然要求填写
    assert.equal((await call('POST', `/api/projects/${pid}/messages`, { text: ' ' })).status, 400);
  } finally {
    server.close();
    await db.close();
  }
});

test('Remix：从历史版本复制出新项目，可选复制应用数据，原项目不变', async () => {
  const { db, server, call, idle } = await boot();
  try {
    const pid = (await call('POST', '/api/projects', { prompt: '做一个房贷计算器', models: ['mock'] })).json.project.id;
    const d = await idle(pid);
    await call('POST', `/api/projects/${pid}/kv`, { set: { history: '[1]' } });
    const vid = d.versions[0].id;
    const a = await call('POST', `/api/versions/${vid}/remix`, { copyData: true });
    assert.equal(a.status, 200);
    const b = await call('POST', `/api/versions/${vid}/remix`, {});
    const pa = (await call('GET', `/api/projects/${a.json.project.id}`)).json;
    assert.equal(pa.versions.length, 1);
    assert.match(pa.project.title, /Remix/);
    assert.ok(pa.messages.some((m) => m.meta?.remixedFrom?.projectId === pid));
    assert.deepEqual((await call('GET', `/api/projects/${a.json.project.id}/kv`)).json.data, { history: '[1]' });
    assert.deepEqual((await call('GET', `/api/projects/${b.json.project.id}/kv`)).json.data, {});
    assert.equal((await call('GET', `/api/projects/${pid}`)).json.versions.length, 1);
    assert.equal((await call('GET', '/api/projects')).json.projects.length, 3);
  } finally {
    server.close();
    await db.close();
  }
});
