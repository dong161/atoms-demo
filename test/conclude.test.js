import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { adoptEntry, concludeRace } from '../server/jobs.js';

const HTML = '<!DOCTYPE html><html><head><title>名片</title></head><body>ok</body></html>';
const review = (ok, total) => ({
  review: { results: Array.from({ length: total }, (_, i) => ({ feature: `功能${i + 1}`, ok: i < ok })) },
});

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
  await db.run("INSERT INTO races (id,project_id,instruction,status,created_at) VALUES ($1,$2,'做名片','review',$3)", [`r-${pid}`, pid, t]);
  for (const [i, e] of entries.entries())
    await db.run(
      'INSERT INTO race_entries (id,race_id,model,status,html,score,score_detail,duration_ms,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        `${pid}-${i}`,
        `r-${pid}`,
        e.model,
        e.status,
        e.status === 'done' ? HTML : null,
        e.score ?? null,
        JSON.stringify(e.detail || {}),
        e.ms || 1000,
        t + i,
      ],
    );
}

test('赛马收尾：全部打完分后自动采用最高分并写出结论，只写一次', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  try {
    await seed(db, 'a', [
      { model: 'claude', status: 'done', score: null, detail: review(6, 8) },
      { model: 'gemini', status: 'done', score: 80, detail: review(4, 8) },
      { model: 'grok', status: 'failed' },
    ]);
    assert.equal(await concludeRace(db, 'r-a'), null, '还有候选没打分时不收尾');
    await db.run("UPDATE race_entries SET score = 90 WHERE id = 'a-0'");
    const out = await concludeRace(db, 'r-a');
    assert.equal(out.autoAdopted, true);
    assert.equal(out.version.seq, 1);
    const p = await db.get("SELECT current_version_id FROM projects WHERE id = 'a'");
    assert.equal(p.current_version_id, out.version.id);
    assert.equal((await db.get('SELECT model FROM versions WHERE id = $1', [out.version.id])).model, 'claude');
    assert.match(out.summary.content, /采用 claude（90 分），已保存为 Version 1/);
    assert.match(out.summary.content, /6\/8 项满足；未满足：功能7；功能8/);
    assert.match(out.summary.content, /gemini 80 分/);
    assert.match(out.summary.content, /1 路没有完成/);
    assert.match(out.summary.content, /补上：功能7/);
    assert.equal(await concludeRace(db, 'r-a'), null, '重复调用不再写结论');
    const kinds = (await db.all("SELECT kind FROM messages WHERE project_id = 'a' ORDER BY created_at")).map((m) => m.kind);
    assert.deepEqual(kinds, ['version', 'summary']);
  } finally {
    await db.close();
  }
});

test('赛马收尾：用户已手动采用了某个候选时，以用户的选择为准，不再自动改', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  try {
    await seed(db, 'b', [
      { model: 'claude', status: 'done', score: 95, detail: review(8, 8) },
      { model: 'gemini', status: 'done', score: 70, detail: review(5, 8) },
    ]);
    await adoptEntry(db, 'b-1');
    const out = await concludeRace(db, 'r-b');
    assert.equal(out.autoAdopted, false);
    assert.match(out.summary.content, /采用 gemini（70 分）/);
    assert.equal((await db.all("SELECT id FROM versions WHERE project_id = 'b'")).length, 1);
  } finally {
    await db.close();
  }
});
