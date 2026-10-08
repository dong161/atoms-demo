import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(crypto.scrypt);
const dummySalt = crypto.randomBytes(16).toString('hex');
import { fileURLToPath } from 'node:url';
import express from 'express';
import { generationOptions } from './generation-options.js';
import { openDb } from './db.js';
import { llmConfig } from './llm.js';
import { JobHub, runRace, adoptEntry, createVersion, addMessage, newId } from './jobs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_MODELS = 3;
const JOBS_PER_HOUR = 30;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// 简单的内存限流：key 在 windowMs 内最多 limit 次
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}
const KV_MAX_VALUE = 200_000;
const KV_MAX_KEYS = 200;

export async function createApp({ db, cfg = llmConfig(), hub = new JobHub() } = {}) {
  db ??= await openDb();
  // 进程重启后，内存里的任务都没了：把残留的 running 标记为失败，避免界面永远转圈
  await db.run("UPDATE race_entries SET status = 'failed', error = '服务重启，任务中断' WHERE status = 'running'");
  await db.run("UPDATE races SET status = 'failed' WHERE status = 'running'");

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const jobLimit = rateLimiter(JOBS_PER_HOUR, 3600_000);
  const signupLimit = rateLimiter(20, 3600_000);
  const loginLimit = rateLimiter(30, 3600_000);
  const shareKvLimit = rateLimiter(120, 60_000);
  const tooMany = (res, msg) => res.status(429).json({ error: msg });

  // ---------- 账号：轻量注册（昵称 + 设备令牌，令牌可作为恢复码换设备登录） ----------
  async function auth(req, res, next) {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: '请先创建账号' });
    // 数据库只存令牌的 SHA-256；兼容早期明文存储的账号，命中后顺手升级
    let user = await db.get('SELECT id, name, created_at FROM users WHERE token = $1', [hashToken(token)]);
    if (!user) {
      user = await db.get('SELECT id, name, created_at FROM users WHERE token = $1', [token]);
      if (user) await db.run('UPDATE users SET token = $1 WHERE id = $2', [hashToken(token), user.id]);
    }
    if (!user) user = await db.get('SELECT u.id, u.name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > $2', [hashToken(token), Date.now()]);
    if (!user) return res.status(401).json({ error: '登录已失效，请重新创建账号或输入恢复码' });
    req.user = user;
    next();
  }

  async function ownProject(req, res) {
    const p = await db.get('SELECT * FROM projects WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!p) { res.status(404).json({ error: '项目不存在' }); return null; }
    return p;
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, db: db.kind, mock: cfg.mockOnly, commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7) }));

  app.get('/api/config', (req, res) => {
    res.json({
      mockOnly: cfg.mockOnly,
      models: cfg.mockOnly ? ['mock'] : cfg.models,
      defaultRace: cfg.mockOnly ? ['mock', 'mock'] : cfg.models.slice(0, 3),
      maxModels: MAX_MODELS,
    });
  });

  app.post('/api/users', wrap(async (req, res) => {
    if (!signupLimit(req.ip)) return tooMany(res, '创建账号太频繁，请稍后再试');
    const name = String(req.body?.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: '请输入昵称' });
    const user = { id: newId(), name, token: crypto.randomBytes(24).toString('base64url'), created_at: Date.now() };
    await db.run('INSERT INTO users (id, name, token, created_at) VALUES ($1,$2,$3,$4)', [user.id, user.name, hashToken(user.token), user.created_at]);
    res.json({ user: { id: user.id, name: user.name }, token: user.token });
  }));

  // 邮箱仅作为账号标识；不宣称邮件验证或密码找回。
  app.post('/api/auth/register', wrap(async (req, res) => {
    if (!signupLimit(req.ip)) return tooMany(res, '创建账号太频繁，请稍后再试');
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!name || name.length > 30) return res.status(400).json({ error: '昵称需为1–30个字符' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入有效邮箱' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: '密码需为10–128个字符' });
    const salt = crypto.randomBytes(16).toString('hex');
    const digest = await scryptAsync(password, salt, 64);
    const token = crypto.randomBytes(24).toString('base64url');
    const user = { id: newId(), name, email };
    try {
      await db.run('INSERT INTO users (id,name,token,created_at,email,password_hash) VALUES ($1,$2,$3,$4,$5,$6)', [user.id,name,hashToken(token),Date.now(),email,`scrypt:${salt}:${digest.toString('hex')}`]);
    } catch (e) {
      if (e.code === '23505' || String(e.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: '此邮箱已注册，请登录' });
      throw e;
    }
    res.json({ user, token });
  }));
  app.post('/api/auth/login', wrap(async (req, res) => {
    if (!loginLimit(req.ip)) return tooMany(res, '登录尝试过多，请一小时后再试');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (email.length > 254 || password.length > 128) return res.status(400).json({ error: '登录信息格式不正确' });
    const user = await db.get('SELECT id,name,email,password_hash FROM users WHERE email = $1', [email]);
    const parts = user?.password_hash?.split(':');
    const digest = await scryptAsync(password, parts?.[1] || dummySalt, 64);
    const expected = Buffer.from(parts?.[2] || '0'.repeat(128), 'hex');
    if (!user || !parts || expected.length !== digest.length || !crypto.timingSafeEqual(expected,digest)) return res.status(401).json({ error: '邮箱或密码不正确' });
    const token = crypto.randomBytes(24).toString('base64url');
    await db.run('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]);
    await db.run('INSERT INTO sessions (token,user_id,expires_at) VALUES ($1,$2,$3)', [hashToken(token),user.id,Date.now()+7*86400_000]);
    res.json({ user: { id:user.id,name:user.name,email:user.email }, token });
  }));

  app.get('/api/me', wrap(auth), (req, res) => res.json({ user: req.user }));

  // ---------- 项目 ----------
  app.get('/api/projects', wrap(auth), wrap(async (req, res) => {
    const rows = await db.all(
      `SELECT p.id, p.title, p.prompt, p.updated_at, p.created_at, p.share_slug, v.seq AS version_seq
       FROM projects p LEFT JOIN versions v ON v.id = p.current_version_id
       WHERE p.user_id = $1 ORDER BY p.updated_at DESC LIMIT 100`,
      [req.user.id],
    );
    res.json({ projects: rows });
  }));

  function pickModels(input) {
    const allowed = cfg.mockOnly ? ['mock'] : cfg.models;
    let list = Array.isArray(input) ? input.map(String).filter((m) => allowed.includes(m) || m === 'mock') : [];
    if (cfg.mockOnly) list = list.map(() => 'mock');
    if (list.length === 0) list = [cfg.mockOnly ? 'mock' : cfg.models[0]];
    return list.slice(0, MAX_MODELS);
  }

  function startJob(project, instruction, mode, models) {
    const job = hub.create(project.id);
    runRace({ db, hub, cfg, job, project, instruction, mode, models }).catch((e) => console.error('runRace', e));
    return job;
  }

  app.post('/api/projects', wrap(auth), wrap(async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (prompt.length < 2) return res.status(400).json({ error: '请描述你想做的应用' });
    if (prompt.length > 2000) return res.status(400).json({ error: '描述太长了，请控制在 2000 字以内' });
    if (!jobLimit(req.user.id)) return tooMany(res, `每小时最多生成 ${JOBS_PER_HOUR} 次，请稍后再试`);
    const options = generationOptions(req.body);
    const t = Date.now();
    const project = { id: newId(), user_id: req.user.id, title: prompt.slice(0, 20), prompt, theme_id:options.themeId, attachments:JSON.stringify(options.attachments), created_at: t, updated_at: t };
    await db.run(
      'INSERT INTO projects (id, user_id, title, prompt, created_at, updated_at,theme_id,attachments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [project.id, project.user_id, project.title, project.prompt, t, t,project.theme_id,project.attachments],
    );
    await addMessage(db, project.id, 'user', 'text', prompt);
    const job = startJob(project, prompt, 'create', pickModels(req.body?.models));
    res.json({ project, jobId: job.id });
  }));

  app.get('/api/projects/:id', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    const [messages, versions, races, entries] = await Promise.all([
      db.all('SELECT * FROM messages WHERE project_id = $1 ORDER BY created_at, id', [p.id]),
      db.all('SELECT id, seq, title, model, source, score, created_at FROM versions WHERE project_id = $1 ORDER BY seq DESC', [p.id]),
      db.all('SELECT * FROM races WHERE project_id = $1 ORDER BY created_at', [p.id]),
      db.all(
        `SELECT e.id, e.race_id, e.model, e.status, e.error, e.source, e.duration_ms, e.score, e.score_detail, e.created_at, LENGTH(e.html) AS size
         FROM race_entries e JOIN races r ON r.id = e.race_id WHERE r.project_id = $1 ORDER BY e.created_at`,
        [p.id],
      ),
    ]);
    const active = hub.activeFor(p.id);
    res.json({
      project: { ...p, plan: p.plan ? JSON.parse(p.plan) : null },
      messages: messages.map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })),
      versions,
      races: races.map((r) => ({ ...r, entries: entries.filter((e) => e.race_id === r.id).map((e) => ({ ...e, score_detail: e.score_detail ? JSON.parse(e.score_detail) : null })) })),
      activeJobId: active?.id ?? null,
    });
  }));

  app.patch('/api/projects/:id', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    const title = String(req.body?.title || '').trim().slice(0, 40);
    if (!title) return res.status(400).json({ error: '标题不能为空' });
    await db.run('UPDATE projects SET title = $1, updated_at = $2 WHERE id = $3', [title, Date.now(), p.id]);
    res.json({ ok: true });
  }));

  app.delete('/api/projects/:id', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    hub.activeFor(p.id)?.ctrl.abort();
    await db.run('DELETE FROM race_entries WHERE race_id IN (SELECT id FROM races WHERE project_id = $1)', [p.id]);
    for (const t of ['races', 'versions', 'messages', 'app_kv']) await db.run(`DELETE FROM ${t} WHERE project_id = $1`, [p.id]);
    await db.run('DELETE FROM projects WHERE id = $1', [p.id]);
    res.json({ ok: true });
  }));

  // 对话式迭代：在当前版本上修改（也可以开赛马）
  app.post('/api/projects/:id/messages', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '请输入修改要求' });
    if (hub.activeFor(p.id)) return res.status(409).json({ error: '上一个任务还在进行中，请稍候或先停止' });
    if (!p.current_version_id) return res.status(409).json({ error: '还没有可修改的版本，请先采用一个候选' });
    if (!jobLimit(req.user.id)) return tooMany(res, `每小时最多生成 ${JOBS_PER_HOUR} 次，请稍后再试`);
    if(text.length>2000)return res.status(400).json({error:'修改要求最多2000字符'});
    const options=generationOptions(req.body,p);
    p.theme_id=options.themeId;p.attachments=JSON.stringify(options.attachments);
    await db.run('UPDATE projects SET updated_at=$1,theme_id=$2,attachments=$3 WHERE id=$4',[Date.now(),p.theme_id,p.attachments,p.id]);
    const message = await addMessage(db, p.id, 'user', 'text', text);
    const job = startJob(p, text, 'edit', pickModels(req.body?.models));
    res.json({ message, jobId: job.id });
  }));

  // ---------- 任务事件流（SSE），支持断线重连回放 ----------
  app.get('/api/jobs/:id/events', wrap(auth), (req, res) => {
    const job = hub.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在或已结束' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const from = Number(req.query.from ?? 0);
    for (const ev of job.events) if (ev.seq >= from || ev.type === 'progress') send(ev);
    if (job.status !== 'running') return res.end();
    const sub = (ev) => { send(ev); if (ev.type === 'end') res.end(); };
    job.subscribers.add(sub);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(ping); job.subscribers.delete(sub); });
  });

  app.post('/api/jobs/:id/cancel', wrap(auth), wrap(async (req, res) => {
    const job = hub.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    const p = await db.get('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [job.projectId, req.user.id]);
    if (!p) return res.status(404).json({ error: '任务不存在' });
    job.ctrl.abort();
    res.json({ ok: true });
  }));

  // ---------- 版本 & 赛马候选 ----------
  async function ownedEntry(req, res) {
    const e = await db.get(
      'SELECT e.* FROM race_entries e JOIN races r ON r.id = e.race_id JOIN projects p ON p.id = r.project_id WHERE e.id = $1 AND p.user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!e) res.status(404).json({ error: '候选不存在' });
    return e;
  }

  app.get('/api/race-entries/:id/html', wrap(auth), wrap(async (req, res) => {
    const e = await ownedEntry(req, res);
    if (!e) return;
    res.json({ html: e.html || '' });
  }));

  app.post('/api/race-entries/:id/score', wrap(auth), wrap(async (req, res) => {
    const e = await ownedEntry(req, res);
    if (!e) return;
    const score = Math.max(0, Math.min(100, Math.round(Number(req.body?.score) || 0)));
    const prev = e.score_detail ? JSON.parse(e.score_detail) : {};
    const detail = { ...prev, runtime: req.body?.detail ?? null };
    await db.run('UPDATE race_entries SET score = $1, score_detail = $2 WHERE id = $3', [score, JSON.stringify(detail), e.id]);
    res.json({ ok: true, score });
  }));

  app.post('/api/race-entries/:id/adopt', wrap(auth), wrap(async (req, res) => {
    const e = await ownedEntry(req, res);
    if (!e) return;
    const out = await adoptEntry(db, e.id);
    res.json(out);
  }));

  async function ownedVersion(req, res) {
    const v = await db.get(
      'SELECT v.* FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.id = $1 AND p.user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!v) res.status(404).json({ error: '版本不存在' });
    return v;
  }

  app.get('/api/versions/:id/html', wrap(auth), wrap(async (req, res) => {
    const v = await ownedVersion(req, res);
    if (!v) return;
    res.json({ html: v.html, title: v.title, seq: v.seq });
  }));

  // 回退：把旧版本复制成一个新版本（历史不丢，与 Atoms 的 Restore 一致）
  app.post('/api/versions/:id/restore', wrap(auth), wrap(async (req, res) => {
    const v = await ownedVersion(req, res);
    if (!v) return;
    if (hub.activeFor(v.project_id)) return res.status(409).json({ error: '有任务在进行中，请稍后再回退' });
    const nv = await createVersion(db, { projectId: v.project_id, html: v.html, model: v.model, source: 'restore', score: v.score, title: v.title });
    const message = await addMessage(db, v.project_id, 'system', 'version', `Version ${nv.seq}: 回退到 Version ${v.seq}`, {
      versionId: nv.id, seq: nv.seq, title: nv.title, restoredFrom: v.seq,
    });
    res.json({ version: { id: nv.id, seq: nv.seq, title: nv.title }, message });
  }));

  // ---------- 发布 / 分享 ----------
  app.post('/api/projects/:id/publish', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    if (!p.current_version_id) return res.status(409).json({ error: '还没有可发布的版本' });
    const slug = p.share_slug || crypto.randomBytes(6).toString('base64url');
    await db.run('UPDATE projects SET share_slug = $1, published_version_id = $2, updated_at = $3 WHERE id = $4', [slug, p.current_version_id, Date.now(), p.id]);
    const v = await db.get('SELECT seq FROM versions WHERE id = $1', [p.current_version_id]);
    res.json({ slug, url: `/s/${slug}`, seq: v?.seq });
  }));

  app.delete('/api/projects/:id/publish', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    // 下线并作废旧链接；访客数据一并清理
    await db.run("DELETE FROM app_kv WHERE project_id = $1 AND scope LIKE 'visitor:%'", [p.id]);
    await db.run('UPDATE projects SET share_slug = NULL, published_version_id = NULL, updated_at = $1 WHERE id = $2', [Date.now(), p.id]);
    res.json({ ok: true });
  }));

  app.get('/api/share/:slug', wrap(async (req, res) => {
    const p = await db.get('SELECT id, title, published_version_id FROM projects WHERE share_slug = $1', [req.params.slug]);
    const v = p && (await db.get('SELECT html, seq FROM versions WHERE id = $1', [p.published_version_id]));
    if (!v) return res.status(404).json({ error: '链接不存在或已下线' });
    res.json({ title: p.title, html: v.html, seq: v.seq });
  }));

  // ---------- 生成应用的云端存储（localStorage 同步到这里） ----------
  async function kvGet(projectId, scope) {
    const rows = await db.all('SELECT k, v FROM app_kv WHERE project_id = $1 AND scope = $2', [projectId, scope]);
    return Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }
  async function kvApply(projectId, scope, body) {
    const set = body?.set && typeof body.set === 'object' ? body.set : {};
    const del = Array.isArray(body?.del) ? body.del : [];
    if (body?.clear) await db.run('DELETE FROM app_kv WHERE project_id = $1 AND scope = $2', [projectId, scope]);
    const count = await db.get('SELECT COUNT(*) AS c FROM app_kv WHERE project_id = $1 AND scope = $2', [projectId, scope]);
    if (Number(count?.c ?? 0) + Object.keys(set).length > KV_MAX_KEYS) throw Object.assign(new Error('存储的键太多了'), { status: 413 });
    for (const [k, v] of Object.entries(set)) {
      const val = String(v);
      if (k.length > 200 || val.length > KV_MAX_VALUE) throw Object.assign(new Error('单条数据过大'), { status: 413 });
      await db.run(
        `INSERT INTO app_kv (project_id, scope, k, v, updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (project_id, scope, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
        [projectId, scope, k, val, Date.now()],
      );
    }
    for (const k of del) await db.run('DELETE FROM app_kv WHERE project_id = $1 AND scope = $2 AND k = $3', [projectId, scope, String(k)]);
  }

  app.get('/api/projects/:id/kv', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    res.json({ data: await kvGet(p.id, 'owner') });
  }));
  app.post('/api/projects/:id/kv', wrap(auth), wrap(async (req, res) => {
    const p = await ownProject(req, res);
    if (!p) return;
    await kvApply(p.id, 'owner', req.body);
    res.json({ ok: true });
  }));

  const visitorScope = (req) => {
    const v = String(req.query.visitor || '');
    return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? `visitor:${v}` : null;
  };
  app.get('/api/share/:slug/kv', wrap(async (req, res) => {
    const p = await db.get('SELECT id FROM projects WHERE share_slug = $1', [req.params.slug]);
    const scope = visitorScope(req);
    if (!p || !scope) return res.status(404).json({ error: '不存在' });
    res.json({ data: await kvGet(p.id, scope) });
  }));
  app.post('/api/share/:slug/kv', wrap(async (req, res) => {
    if (!shareKvLimit(`${req.ip}:${req.params.slug}`)) return tooMany(res, '操作太频繁，请稍后再试');
    const p = await db.get('SELECT id FROM projects WHERE share_slug = $1', [req.params.slug]);
    const scope = visitorScope(req);
    if (!p || !scope) return res.status(404).json({ error: '不存在' });
    await kvApply(p.id, scope, req.body);
    res.json({ ok: true });
  }));

  // ---------- 静态页面 ----------
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
  app.get(['/s/:slug', '/preview'], (req, res) => res.sendFile(path.join(root, 'public', 'share.html')));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.get('*', (req, res) => res.sendFile(path.join(root, 'public', 'index.html')));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? `服务器错误：${err.message}` : err.message });
  });

  return { app, db, hub, cfg };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV !== 'production') {
    try { process.loadEnvFile(path.join(root, '.env')); } catch { /* 没有 .env 就用 mock */ }
  }
  const { app, db, cfg } = await createApp({ cfg: llmConfig() });
  const port = Number(process.env.PORT) || 3100;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Atoms Demo 已启动：http://localhost:${port}  数据库=${db.kind}  模型=${cfg.mockOnly ? 'mock' : cfg.models.join(', ')}`);
  });
}
