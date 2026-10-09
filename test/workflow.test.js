import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { JobHub, runRace } from '../server/jobs.js';

test('工作流程时间线：首轮生成记录读取需求、写开发说明、分派、写文件、验收、出版本，并排在方案消息之前', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  try {
    const t = Date.now();
    const project = { id: 'p', user_id: 'u', title: 't', prompt: '做一个看板', created_at: t, updated_at: t };
    await db.run('INSERT INTO projects (id,user_id,title,prompt,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      'p',
      'u',
      't',
      '做一个看板',
      t,
      t,
    ]);
    const hub = new JobHub();
    const job = hub.create('p', 'u');
    const events = [];
    const emit = hub.emit.bind(hub);
    hub.emit = (j, type, data) => {
      events.push(type);
      return emit(j, type, data);
    };
    await runRace({
      db,
      hub,
      cfg: { mockOnly: true, models: [] },
      job,
      project,
      instruction: '做一个看板',
      mode: 'create',
      models: ['mock'],
    });
    const msgs = await db.all("SELECT kind, meta FROM messages WHERE project_id = 'p' ORDER BY created_at, id");
    assert.deepEqual(
      msgs.map((m) => m.kind),
      ['workflow', 'plan', 'race', 'version'],
    );
    const steps = JSON.parse(msgs[0].meta).steps;
    assert.deepEqual(
      steps.map((s) => s.label),
      ['读取需求', '写入开发说明', '@Alex 按方案开发', '写入文件', '对照需求逐条验收', '保存为 Version 1'],
    );
    assert.ok(steps.every((s) => s.status === 'done'));
    assert.match(steps[3].detail, /行 · \d+ 秒/);
    assert.ok(events.includes('workflow'));
  } finally {
    await db.close();
  }
});
