import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../server/db.js';
import { JobHub, runRace } from '../server/jobs.js';
import { compactForReview } from '../server/agents.js';
import { createApp } from '../server/index.js';

const APP = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>T</title></head><body>${'<p>x</p>'.repeat(200)}<script>1</script></body></html>`;

test('验收用代码视图：去掉样式和图标路径，脚本完整保留，不再把长应用末尾的脚本截掉', () => {
  const css = `<style>${'.a{color:red}\n'.repeat(4000)}</style>`;
  const svg = `<svg><path d="${'M0 0 L10 10 '.repeat(500)}"/></svg>`;
  const markup = '<div class="row">内容</div>\n'.repeat(3000);
  const script = `<script>function saveScheme(){ /* 保存方案 */ }\n${'// 逻辑\n'.repeat(2000)}function importJson(){}</script>`;
  const html = `<!DOCTYPE html><html><head>${css}</head><body>${svg}${markup}${script}</body></html>`;
  assert.ok(html.length > 100_000);
  const out = compactForReview(html);
  assert.ok(!out.includes('.a{color:red}'), '样式表被省略');
  assert.ok(!out.includes('M0 0 L10 10 M0'), 'SVG 路径被省略');
  assert.ok(out.includes('function saveScheme') && out.includes('function importJson'), '脚本首尾都在');
  // 极长标记时，脚本仍然完整
  const huge = `<!DOCTYPE html><html><body>${'<div>很长的标记内容很长的标记内容</div>'.repeat(20000)}${script}</body></html>`;
  const out2 = compactForReview(huge);
  assert.ok(out2.includes('function importJson'), '超长时截短的是标记，不是脚本');
});

test('某一路失败时换备用模型重做这一路，并记入工作流程', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      if (j.model === 'broken') {
        res.writeHead(400);
        return res.end('bad request');
      }
      const sys = j.messages[0]?.content || '';
      const content = sys.includes('验收')
        ? JSON.stringify({ results: [{ ok: true, note: 'ok' }], summary: 'ok' })
        : sys.includes('开发说明')
          ? JSON.stringify({ title: '计数器', summary: 's', features: ['计数'], design: 'd', data: 'n' })
          : APP;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  try {
    const t = Date.now();
    const project = { id: 'p', user_id: 'u', title: 't', prompt: '做一个计数器', created_at: t, updated_at: t };
    await db.run('INSERT INTO projects (id,user_id,title,prompt,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      'p',
      'u',
      't',
      '做一个计数器',
      t,
      t,
    ]);
    const hub = new JobHub();
    const job = hub.create('p', 'u');
    const cfg = {
      mockOnly: false,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: 'k',
      models: ['good', 'broken'],
      fallbacks: ['backup'],
      plannerModel: 'good',
    };
    await runRace({ db, hub, cfg, job, project, instruction: '做一个计数器', mode: 'create', models: ['good', 'broken'] });
    const entries = await db.all('SELECT model, status FROM race_entries ORDER BY created_at');
    assert.deepEqual(
      entries.map((e) => `${e.model}:${e.status}`),
      ['good:done', 'backup:done'],
    );
    const wf = JSON.parse((await db.get("SELECT meta FROM messages WHERE kind = 'workflow'")).meta);
    assert.ok(wf.steps.some((s) => s.label.includes('broken 没有完成，换 backup 重做这一路')));
  } finally {
    server.close();
    await db.close();
  }
});

test('模型上报可带备用清单：保存后重启仍在，且不与主阵容重复', async () => {
  const db = await openDb({ databaseUrl: '', sqlitePath: ':memory:' });
  const cfg = {
    mockOnly: false,
    models: ['a'],
    plannerModel: 'a',
    baseUrl: 'https://old.trycloudflare.com/v1',
    apiKey: 'gateway-token-123',
  };
  const { app } = await createApp({ db, cfg });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/llm-endpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ baseUrl: 'https://x-y.trycloudflare.com/v1', models: ['m1', 'm2', 'm3'], fallbacks: ['m2', 'g1', 'g2'] }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(cfg.fallbacks, ['g1', 'g2']);
  } finally {
    server.close();
  }
  const cfg2 = {
    mockOnly: false,
    models: ['a'],
    plannerModel: 'a',
    baseUrl: 'https://old.trycloudflare.com/v1',
    apiKey: 'gateway-token-123',
  };
  await createApp({ db, cfg: cfg2 });
  assert.deepEqual(cfg2.fallbacks, ['g1', 'g2']);
  await db.close();
});
