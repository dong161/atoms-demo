import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../server/db.js';
import { JobHub, runRace, setLaggingGrace } from '../server/jobs.js';

const APP = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>T</title></head><body>${'<p>x</p>'.repeat(200)}<script>1</script></body></html>`;

// 假模型服务：fast 立即返回，slow 延迟 4 秒；验收请求返回 JSON
async function fakeModels() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const j = JSON.parse(body);
      const sys = j.messages[0]?.content || '';
      const content = sys.includes('验收')
        ? JSON.stringify({ results: [{ ok: true, note: 'ok' }], summary: 'ok' })
        : sys.includes('开发说明')
          ? JSON.stringify({ title: '计数器', summary: 's', features: ['计数'], design: 'd', data: 'n' })
          : APP;
      if (j.model === 'slow') await new Promise((r) => setTimeout(r, 4000));
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('赛马限时：领先候选完成后，过慢的一路被自动淘汰，领先者自动采用', async () => {
  const { server, baseUrl } = await fakeModels();
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  setLaggingGrace(500);
  try {
    const hub = new JobHub();
    const t = Date.now();
    const project = { id: 'p1', user_id: 'u1', title: 't', prompt: '做一个计数器', created_at: t, updated_at: t };
    await db.run('INSERT INTO projects (id,user_id,title,prompt,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      project.id,
      project.user_id,
      project.title,
      project.prompt,
      t,
      t,
    ]);
    const job = hub.create(project.id, 'u1');
    const cfg = { mockOnly: false, baseUrl, apiKey: 'k', models: ['fast', 'slow'], plannerModel: 'fast' };
    const started = Date.now();
    await runRace({ db, hub, cfg, job, project, instruction: '做一个计数器', mode: 'create', models: ['fast', 'slow'] });
    assert.ok(Date.now() - started < 3500, '不应等最慢的一路跑完');
    const entries = await db.all('SELECT model, status, error FROM race_entries ORDER BY model');
    assert.equal(entries.find((e) => e.model === 'fast').status, 'done');
    const slow = entries.find((e) => e.model === 'slow');
    assert.equal(slow.status, 'failed');
    assert.match(slow.error, /自动淘汰/);
    const versions = await db.all('SELECT seq, model FROM versions WHERE project_id = $1', [project.id]);
    assert.deepEqual(versions, [{ seq: 1, model: 'fast' }]);
  } finally {
    setLaggingGrace(90_000);
    server.closeAllConnections?.();
    server.close();
    await db.close();
  }
});
