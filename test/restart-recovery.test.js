import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { recoverInterruptedRaces } from '../server/jobs.js';

const HTML = '<!DOCTYPE html><html><head><title>看板</title></head><body>ok</body></html>';

async function seed(db, pid, entries) {
  const t = Date.now();
  await db.run('INSERT INTO projects (id,user_id,title,prompt,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [
    pid,
    'u',
    't',
    'p',
    t,
    t,
  ]);
  await db.run("INSERT INTO races (id,project_id,instruction,status,created_at) VALUES ($1,$2,'做看板','running',$3)", [
    `r-${pid}`,
    pid,
    t,
  ]);
  for (const [i, e] of entries.entries())
    await db.run('INSERT INTO race_entries (id,race_id,model,status,html,score,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      `e-${pid}-${i}`,
      `r-${pid}`,
      e.model,
      e.status,
      e.status === 'done' ? HTML : null,
      e.score ?? null,
      t + i,
    ]);
}

test('服务重启：已完成的候选不丢——一个完成就采用，多个完成转人工选择，都没完成才算失败', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  try {
    await seed(db, 'one', [
      { model: 'a', status: 'done', score: 79 },
      { model: 'b', status: 'running' },
    ]);
    await seed(db, 'two', [
      { model: 'a', status: 'done', score: 60 },
      { model: 'b', status: 'done', score: 80 },
      { model: 'c', status: 'running' },
    ]);
    await seed(db, 'none', [{ model: 'a', status: 'running' }]);
    const r = await recoverInterruptedRaces(db);
    assert.deepEqual(r.map((x) => x.result).sort(), ['adopted', 'failed', 'review']);

    const one = await db.get('SELECT current_version_id FROM projects WHERE id = $1', ['one']);
    const v = await db.get('SELECT seq, model FROM versions WHERE id = $1', [one.current_version_id]);
    assert.deepEqual(v, { seq: 1, model: 'a' });
    assert.equal((await db.get('SELECT status FROM races WHERE id = $1', ['r-one'])).status, 'adopted');
    assert.equal((await db.get('SELECT status, error FROM race_entries WHERE id = $1', ['e-one-1'])).error, '服务重启，任务中断');

    assert.equal((await db.get('SELECT status FROM races WHERE id = $1', ['r-two'])).status, 'review');
    assert.equal((await db.get('SELECT current_version_id FROM projects WHERE id = $1', ['two'])).current_version_id, null);

    assert.equal((await db.get('SELECT status FROM races WHERE id = $1', ['r-none'])).status, 'failed');
    const msg = await db.get("SELECT kind, content FROM messages WHERE project_id = 'none'");
    assert.equal(msg.kind, 'error');
    // 再跑一次不会重复采用
    assert.deepEqual(await recoverInterruptedRaces(db), []);
  } finally {
    await db.close();
  }
});
