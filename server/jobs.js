// 生成任务调度：一次「生成 / 修改」就是一场赛马（1~N 路模型并行）。
// 任务在服务端跑，事件既推给在线的浏览器（SSE），关键结果也写进数据库；
// 浏览器刷新或断开不会中断任务，重新打开项目会自动续上进度。
import crypto from 'node:crypto';
import { planProject, engineerBuild, reviewBuild, reviewChecklist } from './agents.js';
import { staticCheck, titleFromHtml } from './html.js';

export const newId = () => crypto.randomUUID();
const now = () => Date.now();

export class JobHub {
  constructor() { this.jobs = new Map(); }

  create(projectId) {
    const job = { id: newId(), projectId, status: 'running', events: [], subscribers: new Set(), ctrl: new AbortController(), startedAt: now() };
    this.jobs.set(job.id, job);
    return job;
  }

  emit(job, type, data = {}) {
    const ev = { seq: job.events.length, type, ...data, at: now() };
    // 进度事件只保留最新一条，避免回放时间过长
    if (type === 'progress') {
      const i = job.events.findIndex((e) => e.type === 'progress' && e.entryId === data.entryId);
      if (i >= 0) job.events[i] = ev; else job.events.push(ev);
    } else {
      job.events.push(ev);
    }
    for (const fn of job.subscribers) fn(ev);
  }

  finish(job, status) {
    job.status = status;
    this.emit(job, 'end', { status });
    setTimeout(() => this.jobs.delete(job.id), 10 * 60_000).unref?.();
  }

  activeFor(projectId) {
    for (const j of this.jobs.values()) if (j.projectId === projectId && j.status === 'running') return j;
    return null;
  }
}

export async function addMessage(db, projectId, role, kind, content, meta) {
  const msg = { id: newId(), project_id: projectId, role, kind, content, meta: meta ? JSON.stringify(meta) : null, created_at: now() };
  await db.run(
    'INSERT INTO messages (id, project_id, role, kind, content, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [msg.id, msg.project_id, msg.role, msg.kind, msg.content, msg.meta, msg.created_at],
  );
  return { ...msg, meta: meta ?? null };
}

export async function createVersion(db, { projectId, html, model, source, score, scoreDetail, title }) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM versions WHERE project_id = $1', [projectId]);
  const seq = Number(row?.m ?? 0) + 1;
  const v = {
    id: newId(), project_id: projectId, seq, title: title || titleFromHtml(html), html, model: model ?? null,
    source, score: score ?? null, score_detail: scoreDetail ? JSON.stringify(scoreDetail) : null, created_at: now(),
  };
  await db.run(
    'INSERT INTO versions (id, project_id, seq, title, html, model, source, score, score_detail, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [v.id, v.project_id, v.seq, v.title, v.html, v.model, v.source, v.score, v.score_detail, v.created_at],
  );
  await db.run('UPDATE projects SET current_version_id = $1, updated_at = $2 WHERE id = $3', [v.id, now(), projectId]);
  return v;
}

/** 采用某个赛马候选：生成正式版本、在对话里放一张版本卡片。 */
export async function adoptEntry(db, entryId) {
  const entry = await db.get('SELECT * FROM race_entries WHERE id = $1', [entryId]);
  if (!entry || entry.status !== 'done') throw Object.assign(new Error('该候选还没有生成完成'), { status: 409 });
  const race = await db.get('SELECT * FROM races WHERE id = $1', [entry.race_id]);
  if (race.adopted_entry_id === entryId) throw Object.assign(new Error('这个候选已经采用过了'), { status: 409 });
  // 允许在同一轮里改选另一个候选：每次采用都生成一个新版本，历史可回退
  const version = await createVersion(db, {
    projectId: race.project_id, html: entry.html, model: entry.model, source: entry.source || entry.model,
    score: entry.score, scoreDetail: entry.score_detail ? JSON.parse(entry.score_detail) : null,
  });
  await db.run('UPDATE races SET adopted_entry_id = $1, status = $2 WHERE id = $3', [entryId, 'adopted', race.id]);
  const msg = await addMessage(db, race.project_id, 'alex', 'version', `Version ${version.seq}: ${version.title}`, {
    versionId: version.id, seq: version.seq, title: version.title, model: entry.model, source: entry.source, raceId: race.id, entryId,
  });
  return { version: { id: version.id, seq: version.seq, title: version.title }, message: msg };
}

/**
 * 跑一场赛马。mode = 'create'（首轮，先由 Mike 出方案）| 'edit'（在当前版本上修改）。
 */
export async function runRace({ db, hub, cfg, job, project, instruction, mode, models }) {
  const signal = job.ctrl.signal;
  const emit = (type, data) => hub.emit(job, type, data);
  const say = async (role, kind, content, meta) => {
    const msg = await addMessage(db, project.id, role, kind, content, meta);
    emit('message', { message: msg });
    return msg;
  };

  try {
    let plan = project.plan ? JSON.parse(project.plan) : null;
    let baseHtml = null;

    if (mode === 'create') {
      emit('status', { agent: 'mike', text: 'Mike 正在拆解需求…' });
      plan = await planProject({ cfg, prompt: instruction, signal });
      await db.run('UPDATE projects SET plan = $1, title = $2, updated_at = $3 WHERE id = $4', [JSON.stringify(plan), plan.title, now(), project.id]);
      emit('project', { title: plan.title });
      await say('mike', 'plan', plan.summary, { plan });
    } else {
      const cur = await db.get('SELECT html FROM versions WHERE id = $1', [project.current_version_id]);
      if (!cur) throw new Error('当前项目还没有可修改的版本');
      baseHtml = cur.html;
    }

    const lineup = models.length ? models : ['mock'];
    const raceId = newId();
    await db.run(
      'INSERT INTO races (id, project_id, instruction, base_version_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [raceId, project.id, instruction, mode === 'edit' ? project.current_version_id : null, 'running', now()],
    );
    const entries = lineup.map((model) => ({ id: newId(), model }));
    for (const e of entries) {
      await db.run('INSERT INTO race_entries (id, race_id, model, status, created_at) VALUES ($1,$2,$3,$4,$5)', [e.id, raceId, e.model, 'running', now()]);
    }
    const handoff = lineup.length > 1
      ? `@Alex 赛马模式：${lineup.length} 路模型并行${mode === 'create' ? '开发' : '修改'}，完成后自动校验打分，择优采用。`
      : `@Alex ${mode === 'create' ? '按方案开发' : `修改：${instruction}`}`;
    await say('mike', 'race', handoff, { raceId, mode, entries: entries.map((e) => ({ id: e.id, model: e.model })) });

    const results = await Promise.all(entries.map((e, i) => buildEntry({ db, cfg, emit, signal, entry: e, variant: i, mode, plan, prompt: project.prompt, baseHtml, instruction })));

    if (signal.aborted) throw new Error('已取消');
    let ok = results.filter((r) => r.ok);
    if (ok.length === 0 && mode === 'edit') {
      // 修改失败时不能用演示数据冒充修改结果：保留当前版本，让用户重试
      await db.run("UPDATE races SET status = 'failed' WHERE id = $1", [raceId]);
      throw new Error(`所有模型都没有完成这次修改（${results.map((r) => r.error).filter(Boolean)[0] || '未知原因'}），当前版本保持不变，请稍后重试`);
    }
    if (ok.length === 0) {
      // 首轮生成全部失败：用演示数据兜底，保证流程能走完（候选卡片会标注「已用演示兜底」）
      emit('status', { agent: 'alex', text: '所有模型调用失败，已切换到演示数据兜底' });
      const fb = { id: newId(), model: 'mock' };
      await db.run('INSERT INTO race_entries (id, race_id, model, status, created_at) VALUES ($1,$2,$3,$4,$5)', [fb.id, raceId, fb.model, 'running', now()]);
      emit('entry', { raceId, entry: { id: fb.id, model: 'mock', status: 'running' } });
      const r = await buildEntry({ db, cfg: { ...cfg, mockOnly: true }, emit, signal, entry: fb, variant: 0, mode, plan, prompt: project.prompt, baseHtml, instruction });
      ok = r.ok ? [r] : [];
    }
    if (ok.length === 0) throw new Error('生成失败，请稍后重试');

    if (ok.length === 1) {
      const { version, message } = await adoptEntry(db, ok[0].id);
      emit('message', { message });
      emit('adopted', { raceId, entryId: ok[0].id, version });
    } else {
      await db.run('UPDATE races SET status = $1 WHERE id = $2', ['review', raceId]);
      emit('review', { raceId });
    }
    hub.finish(job, 'done');
  } catch (e) {
    const cancelled = signal.aborted;
    await say('system', 'error', cancelled ? '已停止生成，已完成的部分会保留。' : `出错了：${e.message}`).catch(() => {});
    await db.run("UPDATE races SET status = 'failed' WHERE project_id = $1 AND status = 'running'", [project.id]).catch(() => {});
    await db.run("UPDATE race_entries SET status = 'failed', error = $1 WHERE status = 'running' AND race_id IN (SELECT id FROM races WHERE project_id = $2)", [cancelled ? '已取消' : e.message, project.id]).catch(() => {});
    hub.finish(job, cancelled ? 'cancelled' : 'failed');
  }
}

async function buildEntry({ db, cfg, emit, signal, entry, variant, mode, plan, prompt, baseHtml, instruction }) {
  const started = now();
  let chars = 0;
  let tail = '';
  let lastEmit = 0;
  emit('progress', { entryId: entry.id, chars: 0, tail: '', status: 'running' });
  try {
    const { html, source } = await engineerBuild({
      cfg, model: entry.model, mode, plan, prompt, baseHtml, instruction, variant, signal,
      onDelta: (d) => {
        chars += d.length;
        tail = (tail + d).slice(-400);
        if (now() - lastEmit > 250) { lastEmit = now(); emit('progress', { entryId: entry.id, chars, tail, status: 'running' }); }
      },
      onRetry: (err, n) => emit('status', { agent: 'alex', entryId: entry.id, text: `${entry.model} 第 ${n} 次重试：${err.message}` }),
      onReset: () => { chars = 0; tail = ''; },
    });
    const check = staticCheck(html);
    const duration = now() - started;
    // 代码写完后由 Mike 对照需求逐条验收（计入「需求覆盖」得分）
    emit('progress', { entryId: entry.id, chars: html.length, tail: '代码已完成，Mike 正在对照需求逐条验收…', status: 'running', reviewing: true });
    const review = await reviewBuild({
      cfg: source === 'mock' ? { ...cfg, mockOnly: true } : cfg,
      html, checklist: reviewChecklist({ mode, plan, instruction }), signal,
    });
    const detail = { static: check, review };
    await db.run(
      'UPDATE race_entries SET status = $1, html = $2, source = $3, duration_ms = $4, score_detail = $5 WHERE id = $6',
      ['done', html, source, duration, JSON.stringify(detail), entry.id],
    );
    emit('progress', { entryId: entry.id, chars: html.length, tail: '', status: 'done', durationMs: duration, source, static: check, review });
    return { ok: true, id: entry.id };
  } catch (e) {
    await db.run('UPDATE race_entries SET status = $1, error = $2, duration_ms = $3 WHERE id = $4', ['failed', e.message, now() - started, entry.id]);
    emit('progress', { entryId: entry.id, chars, tail: '', status: 'failed', error: e.message });
    return { ok: false, id: entry.id, error: e.message };
  }
}
