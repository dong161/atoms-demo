// 生成任务调度：一次「生成 / 修改」就是一场赛马（1~N 路模型并行）。
// 任务在服务端跑，事件既推给在线的浏览器（SSE），关键结果也写进数据库；
// 浏览器刷新或断开不会中断任务，重新打开项目会自动续上进度。
import crypto from 'node:crypto';
import { referencePrompt } from './generation-options.js';
import { planProject, engineerBuild, reviewBuild, reviewChecklist } from './agents.js';
import { staticCheck, titleFromHtml } from './html.js';

export const newId = () => crypto.randomUUID();
export const LAGGING = 'lagging';
// 领先一路完成后其余路最多再等这么久：质量高的模型往往更慢，等待太短会让它们总被淘汰
export let LAGGING_GRACE_MS = Number(process.env.RACE_GRACE_MS) || 150_000;
// 整轮至少给这么久：质量好的模型生成完整应用常要 3~4 分钟，不能因为某个快模型 1 分钟就做完而被提前淘汰
export let RACE_MIN_MS = Number(process.env.RACE_MIN_MS) || 300_000;
export const setLaggingGrace = (ms, minMs = RACE_MIN_MS) => {
  LAGGING_GRACE_MS = ms;
  RACE_MIN_MS = minMs;
}; // 测试用
const now = () => Date.now();

export class JobHub {
  constructor() {
    this.jobs = new Map();
  }

  create(projectId, ownerId = null) {
    const job = {
      id: newId(),
      projectId,
      ownerId,
      status: 'running',
      events: [],
      progress: new Map(), // entryId -> 最新进度（只保留最新一条，单独存放，不占事件序号的位置）
      nextSeq: 0,
      subscribers: new Set(),
      ctrl: new AbortController(),
      startedAt: now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  emit(job, type, data = {}) {
    // 序号单调递增；进度事件只保留每个候选的最新一条，避免回放过长
    const ev = { seq: job.nextSeq++, type, ...data, at: now() };
    if (type === 'progress') job.progress.set(data.entryId, ev);
    else job.events.push(ev);
    for (const fn of job.subscribers) fn(ev);
  }

  /** 断线重连时的回放：from 之后的事件 + 各候选的最新进度 */
  replay(job, from = 0) {
    return [...job.events.filter((e) => e.seq >= from), ...job.progress.values()];
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

// 消息按 created_at 排序：同一毫秒内连续写入时顺延 1ms，保证对话顺序与发生顺序一致
let lastMessageAt = 0;
export async function addMessage(db, projectId, role, kind, content, meta) {
  const at = (lastMessageAt = Math.max(now(), lastMessageAt + 1));
  const msg = { id: newId(), project_id: projectId, role, kind, content, meta: meta ? JSON.stringify(meta) : null, created_at: at };
  await db.run('INSERT INTO messages (id, project_id, role, kind, content, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    msg.id,
    msg.project_id,
    msg.role,
    msg.kind,
    msg.content,
    msg.meta,
    msg.created_at,
  ]);
  return { ...msg, meta: meta ?? null };
}

export async function createVersion(db, opts) {
  // (project_id, seq) 有唯一索引：并发采用/回退时撞号就重新取号
  for (let attempt = 0; ; attempt++) {
    try {
      return await insertVersion(db, opts);
    } catch (e) {
      const dup = e.code === '23505' || /UNIQUE constraint failed/.test(String(e.message));
      if (!dup || attempt >= 4) throw e;
    }
  }
}

async function insertVersion(db, { projectId, html, model, source, score, scoreDetail, title }) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM versions WHERE project_id = $1', [projectId]);
  const seq = Number(row?.m ?? 0) + 1;
  const v = {
    id: newId(),
    project_id: projectId,
    seq,
    title: title || titleFromHtml(html),
    html,
    model: model ?? null,
    source,
    score: score ?? null,
    score_detail: scoreDetail ? JSON.stringify(scoreDetail) : null,
    created_at: now(),
  };
  await db.run(
    'INSERT INTO versions (id, project_id, seq, title, html, model, source, score, score_detail, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [v.id, v.project_id, v.seq, v.title, v.html, v.model, v.source, v.score, v.score_detail, v.created_at],
  );
  await db.run('UPDATE projects SET current_version_id = $1, updated_at = $2 WHERE id = $3', [v.id, now(), projectId]);
  return v;
}

/**
 * 工作流程时间线：把智能体的每一步（读取需求、写开发说明、分派、写文件、验收、出版本）记成一条消息的 meta，
 * 实时推给前端，同时存库，刷新页面后仍能看到完整过程。写库串行化，避免并发路同时更新互相覆盖。
 */
export function createWorkflow({ db, emit, projectId }) {
  let msg = null;
  const steps = [];
  let chain = Promise.resolve();
  const persist = () =>
    (chain = chain
      .then(async () => {
        const meta = { steps };
        if (!msg) {
          msg = await addMessage(db, projectId, 'system', 'workflow', '工作流程', meta);
          emit('message', { message: msg });
        } else {
          await db.run('UPDATE messages SET meta = $1 WHERE id = $2', [JSON.stringify(meta), msg.id]);
          emit('workflow', { messageId: msg.id, steps });
        }
      })
      .catch(() => {}));
  return {
    add(step) {
      const id = steps.length;
      steps.push({ id, at: now(), status: 'done', ...step });
      persist();
      return id;
    },
    update(id, patch) {
      if (!steps[id]) return;
      Object.assign(steps[id], patch);
      persist();
    },
    /** 任务异常结束时，把还在进行中的步骤标记为中断 */
    abortRunning(detail) {
      let changed = false;
      for (const st of steps)
        if (st.status === 'running') {
          st.status = 'failed';
          st.detail = detail;
          changed = true;
        }
      if (changed) persist();
    },
    flush: () => chain,
  };
}

const lines = (html) => String(html || '').split('\n').length;
const secs = (ms) => `${Math.max(1, Math.round(ms / 1000))} 秒`;

/**
 * 进程重启后收尾：内存里的任务都没了，把残留的 running 标记为中断。
 * 已经生成完成的候选不能丢：只完成一个就直接采用，完成多个就进入人工选择，一个都没有才算失败。
 */
export async function recoverInterruptedRaces(db) {
  await db.run("UPDATE race_entries SET status = 'failed', error = '服务重启，任务中断' WHERE status = 'running'");
  // 时间线里停在「进行中」的步骤同样标记为中断
  for (const m of await db.all("SELECT id, meta FROM messages WHERE kind = 'workflow' AND meta LIKE '%\"running\"%'")) {
    try {
      const meta = JSON.parse(m.meta);
      for (const st of meta.steps || []) if (st.status === 'running') Object.assign(st, { status: 'failed', detail: '服务重启，任务中断' });
      await db.run('UPDATE messages SET meta = $1 WHERE id = $2', [JSON.stringify(meta), m.id]);
    } catch {
      /* 损坏的记录不影响启动 */
    }
  }
  const races = await db.all("SELECT id, project_id FROM races WHERE status = 'running'");
  const summary = [];
  for (const race of races) {
    const done = await db.all(
      "SELECT id, model FROM race_entries WHERE race_id = $1 AND status = 'done' AND html IS NOT NULL ORDER BY COALESCE(score, -1) DESC, created_at",
      [race.id],
    );
    try {
      if (done.length === 1) {
        await adoptEntry(db, done[0].id);
        await addMessage(db, race.project_id, 'system', 'notice', '服务重启中断了其余候选，已自动采用已完成的那一个。');
        summary.push({ raceId: race.id, result: 'adopted' });
      } else if (done.length > 1) {
        await db.run("UPDATE races SET status = 'review' WHERE id = $1", [race.id]);
        await addMessage(db, race.project_id, 'system', 'notice', '服务重启中断了部分候选，已完成的候选已保留，请选择一个采用。');
        summary.push({ raceId: race.id, result: 'review' });
      } else {
        await db.run("UPDATE races SET status = 'failed' WHERE id = $1", [race.id]);
        await addMessage(db, race.project_id, 'system', 'error', '服务重启，本轮生成中断，请重新发送需求。');
        summary.push({ raceId: race.id, result: 'failed' });
      }
    } catch (e) {
      await db.run("UPDATE races SET status = 'failed' WHERE id = $1 AND status = 'running'", [race.id]).catch(() => {});
      summary.push({ raceId: race.id, result: 'error', error: e.message });
    }
  }
  return summary;
}

/**
 * 一轮赛马的收尾结论：所有完成的候选都打完分后调用（打分在浏览器沙箱里进行，结果逐个写回）。
 * - 用 summary_at 条件更新抢占，保证并发写回时只写一次结论；
 * - 按总分（同分取耗时短）排序，本轮还没采用的就自动采用最高分，让输入框立刻可以继续修改；
 * - Mike 在对话里写出结论：采用了谁、需求满足几项、哪些没满足、其它候选的分数、下一步建议。
 * 返回 null 表示还没到收尾时机（或已经收过尾）。
 */
export async function concludeRace(db, raceId) {
  const race = await db.get('SELECT * FROM races WHERE id = $1', [raceId]);
  if (!race || race.summary_at || race.status === 'running' || race.status === 'failed') return null;
  const entries = await db.all(
    'SELECT id, model, status, score, score_detail, duration_ms, created_at FROM race_entries WHERE race_id = $1',
    [raceId],
  );
  if (entries.some((e) => e.status === 'running')) return null;
  const done = entries.filter((e) => e.status === 'done');
  if (!done.length || done.some((e) => e.score == null)) return null;
  const claim = await db.run('UPDATE races SET summary_at = $1 WHERE id = $2 AND summary_at IS NULL', [now(), raceId]);
  if (!claim.changes) return null;

  const ranked = [...done].sort((a, b) => b.score - a.score || (a.duration_ms || 0) - (b.duration_ms || 0));
  const best = ranked[0];
  const name = (m) => (m === 'mock' ? '演示模型' : m);
  let adoptedId = race.adopted_entry_id;
  let version = null;
  let versionMessage = null;
  if (!adoptedId) {
    try {
      const out = await adoptEntry(db, best.id);
      adoptedId = best.id;
      version = out.version;
      versionMessage = out.message;
    } catch {
      /* 用户刚好手动采用了别的候选：以用户的选择为准 */
      adoptedId = (await db.get('SELECT adopted_entry_id FROM races WHERE id = $1', [raceId]))?.adopted_entry_id;
    }
  }
  const adopted = done.find((e) => e.id === adoptedId) || best;
  if (!version) {
    const p = await db.get('SELECT current_version_id FROM projects WHERE id = $1', [race.project_id]);
    const v = p?.current_version_id ? await db.get('SELECT id, seq, title FROM versions WHERE id = $1', [p.current_version_id]) : null;
    if (v) version = { id: v.id, seq: v.seq, title: v.title };
  }
  const review = adopted.score_detail ? JSON.parse(adopted.score_detail).review : null;
  const results = review?.results || [];
  // 需求条目常常很长（「内联编辑主流程：点击编辑…」）：结论里只用冒号/括号前的短名称
  const shortName = (f) =>
    String(f || '')
      .split(/[：:（(，,]/)[0]
      .trim()
      .slice(0, 24) || String(f || '').slice(0, 24);
  const unmet = results.filter((r) => !r.ok).map((r) => shortName(r.feature));
  const others = ranked.filter((e) => e.id !== adopted.id).map((e) => ({ model: e.model, score: e.score }));
  const failed = entries.filter((e) => e.status === 'failed').length;
  const lines = [
    `本轮结论：${done.length > 1 ? `${done.length} 个候选里` : ''}采用 ${name(adopted.model)}（${adopted.score} 分）${version ? `，已保存为 Version ${version.seq}` : ''}。`,
    results.length
      ? `需求验收：${results.length - unmet.length}/${results.length} 项满足${unmet.length ? `；未满足：${unmet.join('；')}` : '，全部满足'}。`
      : '',
    others.length ? `其它候选：${others.map((o) => `${name(o.model)} ${o.score} 分`).join('、')}，可在赛马对比里试用并改选。` : '',
    failed ? `另有 ${failed} 路没有完成（原因见赛马卡片）。` : '',
    unmet.length
      ? `下一步：直接在下方告诉 Alex「补上：${unmet[0]}」，或点工具栏「选择元素」只改某一处。`
      : '下一步：在预览里试用，想改哪里直接在下方输入，或点「选择元素」只改某一处。',
  ].filter(Boolean);
  const summary = await addMessage(db, race.project_id, 'mike', 'summary', lines.join('\n'), {
    raceId,
    adoptedEntryId: adopted.id,
    score: adopted.score,
    version,
    unmet,
    others,
  });
  return { summary, version, versionMessage, autoAdopted: !!versionMessage };
}

/** 采用某个赛马候选：生成正式版本、在对话里放一张版本卡片。 */
export async function adoptEntry(db, entryId) {
  const entry = await db.get('SELECT * FROM race_entries WHERE id = $1', [entryId]);
  if (!entry || entry.status !== 'done') throw Object.assign(new Error('该候选还没有生成完成'), { status: 409 });
  const race = await db.get('SELECT * FROM races WHERE id = $1', [entry.race_id]);
  // 条件更新抢占：双击或并发请求只有一个能成功
  const claim = await db.run(
    "UPDATE races SET adopted_entry_id = $1, status = 'adopted' WHERE id = $2 AND (adopted_entry_id IS NULL OR adopted_entry_id <> $1)",
    [entryId, race.id],
  );
  if (!claim.changes) throw Object.assign(new Error('这个候选已经采用过了'), { status: 409 });
  // 允许在同一轮里改选另一个候选：每次采用都生成一个新版本，历史可回退
  const version = await createVersion(db, {
    projectId: race.project_id,
    html: entry.html,
    model: entry.model,
    source: entry.source || entry.model,
    score: entry.score,
    scoreDetail: entry.score_detail ? JSON.parse(entry.score_detail) : null,
  });
  const msg = await addMessage(db, race.project_id, 'alex', 'version', `Version ${version.seq}: ${version.title}`, {
    versionId: version.id,
    seq: version.seq,
    title: version.title,
    model: entry.model,
    source: entry.source,
    raceId: race.id,
    entryId,
  });
  return { version: { id: version.id, seq: version.seq, title: version.title }, message: msg };
}

/**
 * 跑一场赛马。mode = 'create'（首轮，先由 Mike 出方案）| 'edit'（在当前版本上修改）。
 */
export async function runRace({ db, hub, cfg, job, project, instruction, hint = '', mode, models }) {
  const files = JSON.parse(project.attachments || '[]');
  const themeId = project.theme_id || 'default';
  const prompt = referencePrompt(project.prompt, files);
  // 附件只发给模型；对话消息、赛马标题和验收清单保留用户的原话
  // hint：点选元素、控制台报错等附加上下文，同样只发给模型
  const modelInstruction = referencePrompt(instruction + hint, files);
  const signal = job.ctrl.signal;
  const emit = (type, data) => hub.emit(job, type, data);
  const say = async (role, kind, content, meta) => {
    await flow.flush(); // 时间线消息先落库，保证它排在本轮其它消息前面
    const msg = await addMessage(db, project.id, role, kind, content, meta);
    emit('message', { message: msg });
    return msg;
  };
  const flow = createWorkflow({ db, emit, projectId: project.id });

  try {
    let plan = project.plan ? JSON.parse(project.plan) : null;
    let baseHtml = null;

    if (mode === 'create') {
      flow.add({
        agent: 'mike',
        action: 'read',
        label: '读取需求',
        detail: `${instruction.length} 字${files.length ? ` · 参考附件 ${files.length} 个` : ''}`,
      });
      emit('status', { agent: 'mike', text: 'Mike 正在拆解需求…' });
      const planStep = flow.add({ agent: 'mike', action: 'think', label: '拆解需求，规划视图与功能', status: 'running' });
      const planStarted = now();
      plan = await planProject({ cfg, prompt: modelInstruction, signal });
      flow.update(planStep, {
        status: 'done',
        action: 'write',
        label: '写入开发说明',
        target: 'PLAN.md',
        detail: `${plan.views?.length ? `${plan.views.length} 个视图 · ` : ''}${plan.features.length} 项功能 · ${secs(now() - planStarted)}`,
      });
      await db.run('UPDATE projects SET plan = $1, title = $2, updated_at = $3 WHERE id = $4', [
        JSON.stringify(plan),
        plan.title,
        now(),
        project.id,
      ]);
      emit('project', { title: plan.title });
      await say('mike', 'plan', plan.summary, { plan });
    } else {
      const cur = await db.get('SELECT html FROM versions WHERE id = $1', [project.current_version_id]);
      if (!cur) throw new Error('当前项目还没有可修改的版本');
      baseHtml = cur.html;
      flow.add({ agent: 'alex', action: 'read', label: '读取文件', target: 'index.html', detail: `当前版本 · ${lines(baseHtml)} 行` });
      if (hint)
        flow.add({ agent: 'alex', action: 'read', label: '读取修改上下文', detail: /报错|错误/.test(hint) ? '控制台报错' : '选中的元素' });
    }

    const lineup = models.length ? models : ['mock'];
    const raceId = newId();
    const raceStarted = now();
    await db.run('INSERT INTO races (id, project_id, instruction, base_version_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      raceId,
      project.id,
      instruction,
      mode === 'edit' ? project.current_version_id : null,
      'running',
      now(),
    ]);
    const entries = lineup.map((model) => ({ id: newId(), model }));
    for (const e of entries) {
      await db.run('INSERT INTO race_entries (id, race_id, model, status, created_at) VALUES ($1,$2,$3,$4,$5)', [
        e.id,
        raceId,
        e.model,
        'running',
        now(),
      ]);
    }
    const handoff =
      lineup.length > 1
        ? `@Alex 赛马模式：${lineup.length} 路模型并行${mode === 'create' ? '开发' : '修改'}，完成后自动校验打分，择优采用。`
        : `@Alex ${mode === 'create' ? '按方案开发' : `修改：${instruction}`}`;
    flow.add({
      agent: 'mike',
      action: 'assign',
      label:
        lineup.length > 1
          ? `@Alex 分派 ${lineup.length} 路并行${mode === 'create' ? '开发' : '修改'}`
          : `@Alex ${mode === 'create' ? '按方案开发' : '修改'}`,
    });
    await say('mike', 'race', handoff, { raceId, mode, entries: entries.map((e) => ({ id: e.id, model: e.model })) });

    // 赛马限时：领先的一路完成后，其余路最多再等 LAGGING_GRACE_MS（且整轮至少 RACE_MIN_MS），超时自动淘汰，避免整轮被最慢的一路拖住
    const laneCtrls = entries.map(() => new AbortController());
    const pendingLanes = entries.map(() => true);
    const onJobAbort = () => laneCtrls.forEach((c) => c.abort());
    signal.addEventListener('abort', onJobAbort, { once: true });
    let graceTimer = null;
    // 某一路报错失败（不是被淘汰或用户停止）时，用备用模型把这一路重做一次；每路最多换一次，同一轮不重复用同一个模型
    const usedModels = new Set(lineup);
    const runLane = async (e, i) => {
      const args = {
        db,
        cfg,
        emit,
        flow,
        lane: entries.length > 1 ? i + 1 : 0,
        signal: laneCtrls[i].signal,
        variant: i,
        mode,
        plan,
        prompt,
        baseHtml,
        instruction: modelInstruction,
        reviewInstruction: instruction,
        themeId,
      };
      let r = await buildEntry({ ...args, entry: e });
      if (r.ok || laneCtrls[i].signal.aborted || signal.aborted) return r;
      const fb = (cfg.fallbacks || []).find((m) => !usedModels.has(m));
      if (!fb) return r;
      usedModels.add(fb);
      await db.run("UPDATE race_entries SET model = $1, status = 'running', error = NULL, duration_ms = NULL WHERE id = $2", [fb, e.id]);
      flow.add({
        agent: 'mike',
        action: 'assign',
        label: `${e.model} 没有完成，换 ${fb} 重做这一路`,
        detail: String(r.error || '').slice(0, 80),
      });
      emit('entry-model', { raceId, entryId: e.id, model: fb, from: e.model });
      r = await buildEntry({ ...args, entry: { ...e, model: fb } });
      return r;
    };
    const results = await Promise.all(
      entries.map((e, i) =>
        runLane(e, i).then((r) => {
          if (r.ok && entries.length > 1 && !graceTimer) {
            graceTimer = setTimeout(
              () => {
                laneCtrls.forEach((c) => c.abort(LAGGING));
                if (laneCtrls.some((c, j) => pendingLanes[j]))
                  emit('status', { agent: 'mike', text: '领先候选已完成，落后太多的模型已自动淘汰' });
              },
              Math.max(LAGGING_GRACE_MS, RACE_MIN_MS - (now() - raceStarted)),
            );
          }
          pendingLanes[i] = false;
          return r;
        }),
      ),
    );
    clearTimeout(graceTimer);
    signal.removeEventListener('abort', onJobAbort);

    if (signal.aborted) throw new Error('已取消');
    let ok = results.filter((r) => r.ok);
    if (ok.length === 0 && mode === 'edit') {
      // 修改失败时不能用演示数据冒充修改结果：保留当前版本，让用户重试
      await db.run("UPDATE races SET status = 'failed' WHERE id = $1", [raceId]);
      throw new Error(
        `所有模型都没有完成这次修改（${results.map((r) => r.error).filter(Boolean)[0] || '未知原因'}），当前版本保持不变，请稍后重试`,
      );
    }
    if (ok.length === 0) {
      // 首轮生成全部失败：用演示数据兜底，保证流程能走完（候选卡片会标注「已用演示兜底」）
      emit('status', { agent: 'alex', text: '所有模型调用失败，已切换到演示数据兜底' });
      const fb = { id: newId(), model: 'mock' };
      await db.run('INSERT INTO race_entries (id, race_id, model, status, created_at) VALUES ($1,$2,$3,$4,$5)', [
        fb.id,
        raceId,
        fb.model,
        'running',
        now(),
      ]);
      emit('entry', { raceId, entry: { id: fb.id, model: 'mock', status: 'running' } });
      const r = await buildEntry({
        db,
        cfg: { ...cfg, mockOnly: true },
        emit,
        flow,
        lane: '演示兜底',
        signal,
        entry: fb,
        variant: 0,
        mode,
        plan,
        prompt,
        baseHtml,
        instruction: modelInstruction,
        reviewInstruction: instruction,
        themeId,
      });
      ok = r.ok ? [r] : [];
    }
    if (ok.length === 0) throw new Error('生成失败，请稍后重试');

    if (ok.length === 1) {
      const { version, message } = await adoptEntry(db, ok[0].id);
      flow.add({ agent: 'alex', action: 'version', label: `保存为 Version ${version.seq}`, detail: version.title });
      await flow.flush();
      emit('message', { message });
      emit('adopted', { raceId, entryId: ok[0].id, version });
    } else {
      await db.run('UPDATE races SET status = $1 WHERE id = $2', ['review', raceId]);
      flow.add({ agent: 'mike', action: 'review', label: `${ok.length} 个候选已完成，等你试用后选择采用` });
      await flow.flush();
      emit('review', { raceId });
    }
    hub.finish(job, 'done');
  } catch (e) {
    if (job.deleted) return hub.finish(job, 'cancelled'); // 项目已删除：不再写任何记录
    const cancelled = signal.aborted;
    flow.abortRunning(cancelled ? '已停止' : e.message);
    await flow.flush();
    await say('system', 'error', cancelled ? '已停止生成，已完成的部分会保留。' : `出错了：${e.message}`).catch(() => {});
    await db.run("UPDATE races SET status = 'failed' WHERE project_id = $1 AND status = 'running'", [project.id]).catch(() => {});
    await db
      .run(
        "UPDATE race_entries SET status = 'failed', error = $1 WHERE status = 'running' AND race_id IN (SELECT id FROM races WHERE project_id = $2)",
        [cancelled ? '已取消' : e.message, project.id],
      )
      .catch(() => {});
    hub.finish(job, cancelled ? 'cancelled' : 'failed');
  }
}

async function buildEntry({
  db,
  cfg,
  emit,
  flow,
  lane = 0,
  signal,
  entry,
  variant,
  mode,
  plan,
  prompt,
  baseHtml,
  instruction,
  reviewInstruction = instruction,
  themeId,
}) {
  const started = now();
  let chars = 0;
  let tail = '';
  let lastEmit = 0;
  emit('progress', { entryId: entry.id, chars: 0, tail: '', status: 'running' });
  const who = typeof lane === 'string' ? lane : lane ? `候选 ${lane}` : '';
  const writeStep = flow?.add({
    agent: 'alex',
    action: 'write',
    label: mode === 'edit' ? '修改文件' : '写入文件',
    target: 'index.html',
    lane: who,
    status: 'running',
  });
  let reviewStep;
  try {
    const { html, source } = await engineerBuild({
      cfg,
      model: entry.model,
      mode,
      plan,
      prompt,
      baseHtml,
      instruction,
      themeId,
      variant,
      signal,
      onDelta: (d) => {
        chars += d.length;
        tail = (tail + d).slice(-400);
        if (now() - lastEmit > 250) {
          lastEmit = now();
          emit('progress', { entryId: entry.id, chars, tail, status: 'running' });
        }
      },
      onRetry: (err, n) => emit('status', { agent: 'alex', entryId: entry.id, text: `${entry.model} 第 ${n} 次重试：${err.message}` }),
      onReset: () => {
        chars = 0;
        tail = '';
      },
    });
    const check = staticCheck(html);
    const duration = now() - started;
    cfg.health?.record(entry.model, { ok: true, ms: duration });
    flow?.update(writeStep, { status: 'done', detail: `${lines(html)} 行 · ${secs(duration)}` });
    reviewStep = flow?.add({ agent: 'mike', action: 'check', label: '对照需求逐条验收', lane: who, status: 'running' });
    // 代码写完后由 Mike 对照需求逐条验收（计入「需求覆盖」得分）
    emit('progress', {
      entryId: entry.id,
      chars: html.length,
      tail: '代码已完成，Mike 正在对照需求逐条验收…',
      status: 'running',
      reviewing: true,
    });
    const review = await reviewBuild({
      cfg: source === 'mock' ? { ...cfg, mockOnly: true } : cfg,
      html,
      checklist: reviewChecklist({ mode, plan, instruction: reviewInstruction }),
      signal,
    });
    const passed = (review?.results || []).filter((r) => r.ok).length;
    flow?.update(reviewStep, {
      status: 'done',
      detail: review?.results?.length ? `${passed}/${review.results.length} 项通过` : '已完成',
    });
    const detail = { static: check, review };
    await db.run('UPDATE race_entries SET status = $1, html = $2, source = $3, duration_ms = $4, score_detail = $5 WHERE id = $6', [
      'done',
      html,
      source,
      duration,
      JSON.stringify(detail),
      entry.id,
    ]);
    emit('progress', {
      entryId: entry.id,
      chars: html.length,
      tail: '',
      status: 'done',
      durationMs: duration,
      source,
      static: check,
      review,
    });
    return { ok: true, id: entry.id };
  } catch (e) {
    // 用户主动停止不算模型的问题；被淘汰或出错都计入健康度
    if (!(signal.aborted && signal.reason !== LAGGING)) cfg.health?.record(entry.model, { ok: false, ms: now() - started });
    if (signal.reason === LAGGING)
      e = new Error(
        `领先候选完成后又等了 ${Math.round(LAGGING_GRACE_MS / 1000)} 秒（整轮至少 ${Math.round(RACE_MIN_MS / 60000)} 分钟）仍未完成，已自动淘汰`,
      );
    await db.run('UPDATE race_entries SET status = $1, error = $2, duration_ms = $3 WHERE id = $4', [
      'failed',
      e.message,
      now() - started,
      entry.id,
    ]);
    flow?.update(reviewStep ?? writeStep, { status: 'failed', detail: e.message.slice(0, 120) });
    emit('progress', { entryId: entry.id, chars, tail: '', status: 'failed', error: e.message });
    return { ok: false, id: entry.id, error: e.message };
  }
}
