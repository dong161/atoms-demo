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

test('修改轮：Mike 先写修改方案（作为验收清单），打分收尾后时间线最后一步是结果', async () => {
  const { concludeRace } = await import('../server/jobs.js');
  const { reviewChecklist } = await import('../server/agents.js');
  assert.deepEqual(
    reviewChecklist({ mode: 'edit', plan: { features: ['原功能'] }, instruction: '适配手机', changes: ['底部导航', '卡片单列'] }),
    ['本次修改：底部导航', '本次修改：卡片单列', '原功能'],
  );
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  try {
    const t = Date.now();
    await db.run('INSERT INTO projects (id,user_id,title,prompt,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      'p',
      'u',
      't',
      '做一个看板',
      t,
      t,
    ]);
    const hub = new JobHub();
    const cfg = { mockOnly: true, models: [] };
    const project = await db.get("SELECT * FROM projects WHERE id = 'p'");
    await runRace({ db, hub, cfg, job: hub.create('p', 'u'), project, instruction: '做一个看板', mode: 'create', models: ['mock'] });
    const p2 = await db.get("SELECT * FROM projects WHERE id = 'p'");
    await runRace({
      db,
      hub,
      cfg,
      job: hub.create('p', 'u'),
      project: p2,
      instruction: '适配手机',
      mode: 'edit',
      models: ['mock', 'mock'],
    });
    const wfs = await db.all("SELECT meta FROM messages WHERE project_id = 'p' AND kind = 'workflow' ORDER BY created_at");
    const edit = JSON.parse(wfs[1].meta);
    assert.ok(edit.steps.some((s) => s.label === '写入修改方案'));
    assert.equal(edit.steps.at(-1).label, '2 个候选已完成，等你试用后选择采用');
    // 打分写回后收尾
    const race = await db.get("SELECT id FROM races WHERE project_id = 'p' ORDER BY created_at DESC LIMIT 1");
    await db.run('UPDATE race_entries SET score = 88 WHERE race_id = $1', [race.id]);
    await concludeRace(db, race.id);
    const after = JSON.parse(
      (await db.all("SELECT meta FROM messages WHERE project_id = 'p' AND kind = 'workflow' ORDER BY created_at"))[1].meta,
    );
    assert.match(after.steps.at(-1).label, /^打分完成：采用 演示模型（88 分），存为 Version 2$/);
    assert.ok(!after.steps.some((s) => s.action === 'review'));
  } finally {
    await db.close();
  }
});
