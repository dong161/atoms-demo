// 赛马对比：候选卡片、缩略图、自动校验打分
import { adopt } from './actions.js';
import { $, api, esc, fmtChars, modelLabel, state, toast } from './core.js';
import { renderViewer } from './preview.js';
import { mountPreview, probeApp } from './sandbox.js';
import { findEntry, reloadProject, renderChat, renderComposer, setView } from './workspace.js';

// ---------- 赛马对比 ----------
export function renderRace(box) {
  const ws = state.ws;
  const race = ws.data.races.find((r) => r.id === ws.view.id);
  if (!race) {
    box.innerHTML = '';
    return;
  }
  const scores = ws.scores || {};
  const done = race.entries.filter((e) => e.status === 'done');
  const allDone = race.entries.every((e) => e.status !== 'running');
  // 总分相同则更快完成的优先
  const ranked = done
    .filter((e) => scores[e.id])
    .sort((a, b) => scores[b.id].score - scores[a.id].score || (a.duration_ms ?? 1e9) - (b.duration_ms ?? 1e9));
  const best = allDone && ranked.length === done.length && ranked.length > 1 ? ranked[0].id : null;
  const multi = race.entries.length > 1;
  const sub = !allDone
    ? `${race.entries.length} 路${multi ? '模型并行' : ''}生成中，代码实时流式输出`
    : best
      ? race.adopted_entry_id
        ? `已采用 <b>${esc(modelLabel(race.entries.find((e) => e.id === race.adopted_entry_id)?.model || ''))}</b> 为当前版本${race.adopted_entry_id === best ? '（最高分）' : ''}。想换可以点其它候选的「采用此版本」；要细改某一处，到版本预览里用「选择元素」。 <button class="btn sm" data-goto-current>预览并修改当前版本</button>`
        : `推荐采用 <b>${esc(modelLabel(race.entries.find((e) => e.id === best).model))}</b>（${scores[best].score} 分），打分完成后会自动采用。`
      : ws.scoring.size
        ? '正在沙箱里自动校验：模拟点击、填写、检测报错与移动端适配…'
        : race.status === 'failed'
          ? '这一轮生成失败了，可以在左侧重新描述需求再试一次。'
          : '生成完成。';
  box.innerHTML = `<div class="race">
    <div class="race-head"><div><h3>${multi ? '🏁 赛马对比' : '⚙️ 生成过程'} <span class="badge">${esc(race.instruction?.slice(0, 40) || '')}</span></h3><p>${sub}</p></div>
      ${allDone && done.length ? '<button class="btn sm" id="rescore">重新校验</button>' : ''}</div>
    <div class="race-grid">${race.entries.map((e) => entryCard(race, e, best)).join('')}</div>
  </div>`;
  box.querySelectorAll('[data-try]').forEach((b) => (b.onclick = () => setView({ type: 'entry', id: b.dataset.try })));
  box.querySelectorAll('[data-adopt]').forEach((b) => (b.onclick = () => adopt(b.dataset.adopt)));
  box.querySelectorAll('[data-goto-version]').forEach((b) => (b.onclick = () => setView({ type: 'version', id: b.dataset.gotoVersion })));
  box
    .querySelectorAll('[data-goto-current]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          state.ws.data.project.current_version_id && setView({ type: 'version', id: state.ws.data.project.current_version_id })),
    );
  $('#rescore') &&
    ($('#rescore').onclick = () => {
      for (const e of done) delete scores[e.id];
      scheduleScoring(true);
      renderViewer(true);
    });
  // 已完成的候选挂一个缩小的可交互缩略预览
  for (const e of done) mountThumb(e.id);
}

export function entryCard(race, e, best) {
  const ws = state.ws;
  const p = ws.progress[e.id] || {};
  const sc = ws.scores?.[e.id];
  const adopted = race.adopted_entry_id === e.id;
  const statusBadge =
    e.status === 'running'
      ? '<span class="badge primary"><span class="spinner" style="width:10px;height:10px"></span>生成中</span>'
      : e.status === 'failed'
        ? '<span class="badge err">失败</span>'
        : adopted
          ? '<span class="badge ok">✓ 已采用</span>'
          : best === e.id
            ? '<span class="badge primary">★ 推荐</span>'
            : '<span class="badge ok">完成</span>';
  let stage;
  if (e.status === 'running') stage = `<div class="stream" data-stream="${e.id}">${esc(p.tail || waitingText(e.id))}</div>`;
  else if (e.status === 'failed') stage = `<div class="fail">${esc(e.error || p.error || '生成失败')}</div>`;
  else stage = `<div data-thumb="${e.id}" style="position:absolute;inset:0"></div>`;
  let scoreHtml = '';
  if (e.status === 'done') {
    if (sc) {
      scoreHtml = `<div class="score-row"><span class="score-big">${sc.score}</span><span style="font-size:12px;color:var(--muted)">/ 100 自动校验</span></div>
        <div class="score-items">${sc.items.map((i) => `<div class="score-item" title="${esc(i.note)}"><span>${esc(i.label)}</span><span class="bar"><i style="width:${Math.round((i.got / i.max) * 100)}%"></i></span><span class="num">${i.got}/${i.max}</span></div>`).join('')}</div>
        ${reviewHtml(sc.review)}`;
    } else {
      scoreHtml = `<div style="font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center"><span class="spinner"></span>自动校验中…</div>`;
    }
  }
  const versionMsg = adopted && ws.data.messages.find((m) => m.kind === 'version' && m.meta?.entryId === e.id);
  const chars = e.status === 'running' ? p.chars : (p.chars ?? e.size);
  const dur = p.durationMs ?? e.duration_ms;
  return `<div class="entry${best === e.id ? ' best' : ''}" data-entry="${e.id}">
    <div class="entry-head"><span class="model">${esc(modelLabel(e.model))}</span>${statusBadge}</div>
    <div class="entry-stage">${stage}</div>
    <div class="entry-body">
      <div class="entry-stats"><span data-chars="${e.id}">📝 ${fmtChars(chars)} 字</span>${dur ? `<span>⏱ ${(dur / 1000).toFixed(1)}s</span>` : ''}${(e.source || p.source) === 'mock' && e.model !== 'mock' ? '<span class="badge warn">已用演示兜底</span>' : ''}</div>
      ${scoreHtml}
      ${
        e.status === 'done'
          ? `<div class="entry-actions"><button class="btn sm" data-try="${e.id}">全屏试用</button>${
              adopted
                ? versionMsg
                  ? `<button class="btn sm" data-goto-version="${versionMsg.meta.versionId}">查看版本</button>`
                  : ''
                : `<button class="btn sm primary" data-adopt="${e.id}">采用此版本</button>`
            }</div>`
          : ''
      }
    </div>
  </div>`;
}

export function waitingText(entryId) {
  const hit = findEntry(entryId);
  const start = Number(hit?.entry.created_at) || Date.now();
  const sec = Math.max(0, Math.round((Date.now() - start) / 1000));
  return `模型正在思考方案… 已用时 ${sec}s\n（推理型模型会先思考再开始输出代码）`;
}

// 生成中的候选：没有输出时每秒刷新「已用时」，避免看起来像卡住
setInterval(() => {
  const ws = state.ws;
  if (!ws?.jobId) return;
  document.querySelectorAll('[data-stream]').forEach((el) => {
    const id = el.dataset.stream;
    if (!ws.progress[id]?.tail) el.textContent = waitingText(id);
  });
}, 1000);

export function reviewHtml(review) {
  if (!review?.results?.length) return review?.summary ? `<div class="review-note">${esc(review.summary)}</div>` : '';
  const miss = review.results.filter((r) => !r.ok);
  return `<details class="review"><summary>Mike 验收：${review.results.length - miss.length}/${review.results.length} 项满足${miss.length ? `，<span style="color:var(--err)">${miss.length} 项未满足</span>` : ' ✓'}</summary>
    <ul>${review.results.map((r) => `<li class="${r.ok ? 'ok' : 'miss'}">${r.ok ? '✓' : '✗'} ${esc(r.feature)}${r.note ? `<span>${esc(r.note)}</span>` : ''}</li>`).join('')}</ul>
    ${review.summary ? `<div class="review-note">${esc(review.summary)}</div>` : ''}</details>`;
}

export function patchEntry(ev) {
  const s = document.querySelector(`[data-stream="${ev.entryId}"]`);
  if (s) s.textContent = ev.tail || waitingText(ev.entryId);
  const c = document.querySelector(`[data-chars="${ev.entryId}"]`);
  if (c) c.textContent = `📝 ${fmtChars(ev.chars)} 字`;
}

export const thumbCache = new Map();
export async function mountThumb(entryId) {
  const slot = document.querySelector(`[data-thumb="${entryId}"]`);
  if (!slot) return;
  try {
    let html = thumbCache.get(entryId);
    if (!html) {
      html = (await api(`/api/race-entries/${entryId}/html`)).html;
      thumbCache.set(entryId, html);
    }
    const target = document.querySelector(`[data-thumb="${entryId}"]`);
    // 赛马面板会频繁重绘：每个缩略图槽位只挂载一次，避免叠出多个 iframe
    if (!target || target.dataset.mounted) return;
    target.dataset.mounted = '1';
    await mountPreview(target, html, {});
    const frame = target.querySelector('iframe');
    const scale = target.clientWidth / 1024;
    frame.classList.add('thumb');
    frame.style.width = '1024px';
    frame.style.height = `${Math.ceil(target.clientHeight / scale)}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = '0 0';
  } catch {
    /* 缩略图失败不影响主流程 */
  }
}

// ---------- 自动校验 ----------
export let scoringQueue = Promise.resolve();
export function scheduleScoring(force = false) {
  const ws = state.ws;
  if (!ws?.data) return;
  ws.scores ||= {};
  for (const race of ws.data.races) {
    for (const e of race.entries) {
      if (e.status !== 'done' || ws.scoring.has(e.id)) continue;
      if (!force && ws.scores[e.id]) continue;
      ws.scoring.add(e.id);
      scoringQueue = scoringQueue.then(() => scoreEntry(ws, e)).catch(() => {});
    }
  }
  if (ws.scoring.size) renderChat();
}

export async function scoreEntry(ws, e) {
  try {
    const html = thumbCache.get(e.id) || (await api(`/api/race-entries/${e.id}/html`)).html;
    thumbCache.set(e.id, html);
    const staticScore = e.score_detail?.static?.score ?? 10;
    const review = e.score_detail?.review ?? null;
    const result = await probeApp(html, { staticScore, review });
    if (ws.closed) return;
    ws.scores[e.id] = result;
    api(`/api/race-entries/${e.id}/score`, {
      method: 'POST',
      body: { score: result.score, detail: { score: result.score, items: result.items } },
    })
      .then(async (r) => {
        // 最后一个分数写回后，服务端会自动采用最高分并写出结论：刷新对话，切到新版本
        if (!r?.concluded || ws.closed || state.ws !== ws) return;
        await reloadProject({ keepView: !r.concluded.autoAdopted });
        if (r.concluded.autoAdopted && r.concluded.version) {
          setView({ type: 'version', id: r.concluded.version.id });
          toast(`已采用推荐的候选（${r.concluded.summary?.meta?.score ?? ''} 分），可以继续修改了`);
        }
      })
      .catch(() => {});
  } finally {
    ws.scoring.delete(e.id);
    if (!ws.closed && state.ws === ws) {
      if (ws.view?.type === 'race') renderViewer(true);
      renderChat(); // 更新「还剩 N 个」的打分进度
      if (ws.scoring.size === 0) renderComposer();
    }
  }
}
