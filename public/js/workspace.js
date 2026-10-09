// 工作区：加载项目、对话、输入框、任务事件流
import { downloadCurrent, publish, renameProject, renderDrawer } from './actions.js';
import { bindComposerOptions, optionsMarkup, readComposerOptions } from './composer-options.js';
import { $, AGENTS, ICONS, api, avatar, esc, fmtChars, fmtTime, modelLabel, raceModels, state, store, toast } from './core.js';
import { bindRaceControls, raceControls, topbar } from './home.js';
import { renderViewer } from './preview.js';
import { patchEntry, scheduleScoring } from './race.js';

// ======================= 工作区 =======================
export function closeWorkspace() {
  const ws = state.ws;
  if (!ws) return;
  ws.abort?.abort();
  ws.preview?.destroy();
  ws.closed = true;
  state.ws = null;
}

export async function openWorkspace(id) {
  if (state.ws?.id === id) return;
  closeWorkspace();
  const ws = {
    id,
    data: null,
    view: null,
    device: store.get('atoms.device', 'desktop'),
    consoleOpen: false,
    consoleLines: [],
    progress: {},
    scoring: new Set(),
    status: '',
    tab: 'preview',
    previewKey: null,
    drawer: false,
  };
  state.ws = ws;
  $('#app').innerHTML =
    `<div class="ws"><div class="ws-header"><button class="icon-btn" onclick="location.hash='#/'">${ICONS.back}</button><span class="spinner"></span></div></div>`;
  try {
    await reloadProject();
  } catch (e) {
    if (ws.closed) return;
    $('#app').innerHTML =
      `${topbar()}<main class="home"><div class="empty">${esc(e.status === 404 ? '项目不存在或无权访问' : e.message)}<br><br><a class="btn" href="#/">返回首页</a></div></main>`;
    return;
  }
}

export async function reloadProject({ keepView = true } = {}) {
  const ws = state.ws;
  if (!ws) return;
  const data = await api(`/api/projects/${ws.id}`);
  if (ws.closed) return;
  ws.data = data;
  for (const r of data.races)
    for (const e of r.entries) {
      const runtime = e.score_detail?.runtime;
      if (e.score != null && runtime) ws.scores = { ...(ws.scores || {}), [e.id]: runtime };
    }
  document.title = `${data.project.title} · Atoms Demo`;
  if (!keepView || !ws.view || !viewIsValid(ws.view)) ws.view = defaultView();
  const needSub = data.activeJobId && ws.subscribedJob !== data.activeJobId;
  if (data.activeJobId) ws.jobId = data.activeJobId;
  else {
    ws.jobId = null;
    ws.status = '';
  }
  renderWorkspace();
  if (needSub) subscribe(data.activeJobId);
  scheduleScoring();
}

export function viewIsValid(v) {
  const d = state.ws.data;
  if (v.type === 'version') return d.versions.some((x) => x.id === v.id);
  if (v.type === 'race') return d.races.some((x) => x.id === v.id);
  if (v.type === 'entry') return d.races.some((r) => r.entries.some((e) => e.id === v.id));
  return v.type === 'empty';
}

export function defaultView() {
  const d = state.ws.data;
  const last = d.races[d.races.length - 1];
  if (last && (last.status === 'running' || last.status === 'review')) return { type: 'race', id: last.id };
  if (d.project.current_version_id) return { type: 'version', id: d.project.current_version_id };
  if (last) return { type: 'race', id: last.id };
  return { type: 'empty' };
}

export function setView(view) {
  state.ws.view = view;
  state.ws.tab = 'preview';
  renderWorkspace();
}

export const findEntry = (id) => {
  for (const r of state.ws.data.races) {
    const e = r.entries.find((x) => x.id === id);
    if (e) return { race: r, entry: e };
  }
  return null;
};

export function renderWorkspace() {
  const ws = state.ws;
  const { project, versions } = ws.data;
  const cur = versions.find((v) => v.id === project.current_version_id);
  const published = project.share_slug && project.published_version_id;
  const publishLabel = !published ? '发布' : project.published_version_id === project.current_version_id ? '已发布' : '更新发布';
  const running = !!ws.jobId;
  const app = $('#app');
  app.innerHTML = `<div class="ws">
    <div class="ws-header">
      <button class="icon-btn" id="ws-back" title="返回首页">${ICONS.back}</button>
      <span class="ws-title" id="ws-title" title="点击重命名">${esc(project.title)}</span>
      ${cur ? `<span class="badge primary">Version ${cur.seq}</span>` : ''}
      <div class="ws-actions">
        <button class="btn sm" id="ws-history">${ICONS.history}<span class="wide">版本历史</span></button>
        <button class="btn sm wide" id="ws-download" ${cur ? '' : 'disabled'}>${ICONS.download}下载</button>
        <button class="btn sm primary" id="ws-publish" ${cur && !running ? '' : 'disabled'}>${publishLabel}</button>
      </div>
    </div>
    <div class="ws-tabs"><button data-tab="chat" class="${ws.tab === 'chat' ? 'on' : ''}">对话</button><button data-tab="preview" class="${ws.tab === 'preview' ? 'on' : ''}">预览</button></div>
    <div class="ws-body" data-tab="${ws.tab}">
      <section class="chat">
        <div class="chat-list" id="chat-list"></div>
        <form class="chat-composer" id="chat-form"></form>
      </section>
      <section class="viewer" id="viewer"></section>
    </div>
  </div>
  ${ws.drawer ? '<div id="drawer-slot"></div>' : ''}`;
  $('#ws-back').onclick = () => (location.hash = '#/');
  $('#ws-title').onclick = renameProject;
  $('#ws-history').onclick = () => {
    ws.drawer = !ws.drawer;
    renderWorkspace();
  };
  $('#ws-download').onclick = downloadCurrent;
  $('#ws-publish').onclick = publish;
  app.querySelectorAll('.ws-tabs button').forEach(
    (b) =>
      (b.onclick = () => {
        ws.tab = b.dataset.tab;
        renderWorkspace();
      }),
  );
  ws.previewKey = null;
  ws.preview?.destroy();
  ws.preview = null;
  renderChat();
  renderComposer();
  renderViewer();
  if (ws.drawer) renderDrawer();
}

// ---------- 对话 ----------
export function renderChat() {
  const ws = state.ws;
  const list = $('#chat-list');
  if (!list) return;
  const html = ws.data.messages.map(renderMessage).join('');
  const working = ws.jobId ? `<div class="working"><span class="spinner"></span>${esc(ws.status || '智能体正在工作…')}</div>` : '';
  list.innerHTML = html + working;
  list.querySelectorAll('[data-open-race]').forEach((b) => (b.onclick = () => setView({ type: 'race', id: b.dataset.openRace })));
  list.querySelectorAll('[data-open-version]').forEach((b) => (b.onclick = () => setView({ type: 'version', id: b.dataset.openVersion })));
  list.scrollTop = list.scrollHeight;
}

export function renderMessage(m) {
  const ws = state.ws;
  if (m.role === 'user') {
    const t = m.meta?.target;
    const chip = t
      ? `<div class="msg-chip">${ICONS.pick} 选中元素 &lt;${esc(t.tag)}&gt;${t.text ? ` “${esc(t.text.slice(0, 24))}”` : ''}</div>`
      : m.meta?.fixErrors
        ? `<div class="msg-chip">${ICONS.wrench} 附带 ${m.meta.fixErrors} 条报错</div>`
        : '';
    return `<div class="msg user"><div class="body">${chip}<div class="bubble">${esc(m.content)}</div></div></div>`;
  }
  const who = AGENTS[m.role] || AGENTS.system;
  const head = `<div class="who"><b>${who.name}</b>${who.role ? ` · ${who.role}` : ''} · ${fmtTime(m.created_at)}</div>`;
  if (m.kind === 'plan' && m.meta?.plan) {
    const p = m.meta.plan;
    return `<div class="msg">${avatar(m.role)}<div class="body">${head}
      <div class="bubble plan-card"><h4>📋 ${esc(p.title)}</h4>${esc(p.summary)}
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${p.design ? `<div class="kv">🎨 ${esc(p.design)}</div>` : ''}${p.data ? `<div class="kv">💾 ${esc(p.data)}</div>` : ''}
        <div class="kv">${p.source === 'mock' ? '<span class="badge warn">演示数据</span>' : `<span class="badge">由 ${esc(p.source)} 拆解</span>`}</div>
      </div></div></div>`;
  }
  if (m.kind === 'race') {
    const race = ws.data.races.find((r) => r.id === m.meta?.raceId);
    const entries = race?.entries ?? [];
    const steps = entries
      .map((e) => {
        const p = ws.progress[e.id];
        const st = p?.status || e.status;
        const text =
          st === 'running'
            ? `生成中 · ${fmtChars(p?.chars)} 字`
            : st === 'done'
              ? `完成 · ${fmtChars(p?.chars ?? e.size)} 字 · ${((p?.durationMs ?? e.duration_ms ?? 0) / 1000).toFixed(1)}s`
              : `失败 · ${esc(p?.error || e.error || '')}`;
        return `<div class="step ${st}"><span class="dot"></span><b>${esc(modelLabel(e.model))}</b>&nbsp;${text}</div>`;
      })
      .join('');
    const doneCount = entries.filter((e) => (ws.progress[e.id]?.status || e.status) !== 'running').length;
    return `<div class="msg">${avatar(m.role)}<div class="body">${head}
      <div class="bubble">${esc(m.content)}</div>
      ${
        race
          ? `<details class="activity" open><summary>${doneCount < entries.length ? '<span class="spinner"></span>' : '✓'} Alex 处理了 ${entries.length} 路任务（${doneCount}/${entries.length}）
        <button class="btn sm" style="margin-left:auto" data-open-race="${race.id}">${entries.length > 1 ? '查看赛马' : '查看过程'}</button></summary>
        <div class="steps">${steps}</div></details>`
          : ''
      }
      </div></div>`;
  }
  if (m.kind === 'version') {
    const meta = m.meta || {};
    const v = ws.data.versions.find((x) => x.id === meta.versionId);
    const sc = meta.entryId && ws.scores?.[meta.entryId];
    const current = ws.data.project.current_version_id === meta.versionId;
    return `<div class="msg">${avatar(m.role === 'system' ? 'system' : 'alex')}<div class="body">${head}
      <div class="version-card"><span class="v-ico">V${meta.seq}</span>
        <div class="v-text"><b>${esc(v?.title || meta.title)}</b><span>${meta.restoredFrom ? `回退自 Version ${meta.restoredFrom}` : esc(modelLabel(meta.model || ''))}${sc ? ` · 校验 ${sc.score} 分` : ''}${current ? ' · 当前' : ''}</span></div>
        ${v ? `<button class="btn sm" data-open-version="${v.id}">预览</button>` : '<span class="badge">已删除</span>'}
      </div></div></div>`;
  }
  const cls = m.kind === 'error' ? 'error' : m.role === 'system' ? 'system' : '';
  return `<div class="msg ${cls}">${avatar(m.role)}<div class="body">${head}<div class="bubble">${esc(m.content)}</div></div></div>`;
}

export function renderComposer() {
  const ws = state.ws;
  const form = $('#chat-form');
  if (!form) return;
  const canEdit = !!ws.data.project.current_version_id;
  const running = !!ws.jobId;
  ws.generation ??= readComposerOptions(ws.data.project);
  const options = ws.generation;
  const old = $('#chat-input')?.value ?? ws.draft ?? '';
  const target = ws.target;
  const placeholder = !canEdit
    ? '等第一个版本生成后，就可以在这里继续修改'
    : target
      ? '说说这个元素要怎么改，例如：改成圆角绿色按钮，文字换成「开始专注」'
      : '描述要修改的地方，例如：主色换成蓝色，再加一个按截止日期排序的按钮';
  form.innerHTML = `
    ${
      target
        ? `<div class="target-chip">${ICONS.pick}<span>只修改选中的 <b>&lt;${esc(target.tag)}&gt;</b>${target.text ? ` “${esc(target.text.slice(0, 30))}”` : ''}</span><button type="button" class="icon-btn" id="target-clear" title="取消选择">✕</button></div>`
        : ''
    }
    <textarea id="chat-input" rows="2" maxlength="2000" placeholder="${placeholder}" ${canEdit ? '' : 'disabled'}></textarea>
    <div class="bar">
      <div class="composer-left" id="chat-race"></div>
      ${
        running
          ? `<button type="button" class="btn sm danger" id="stop-btn">${ICONS.stop} 停止</button>`
          : `<button type="submit" class="btn sm primary" ${canEdit ? '' : 'disabled'}>发送修改</button>`
      }
    </div>`;
  const ta = $('#chat-input');
  ta.value = old;
  ta.oninput = () => (ws.draft = ta.value);
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  const slot = $('#chat-race');
  slot.innerHTML = optionsMarkup(options) + `<div class="race-settings hidden" data-advanced-race>${raceControls()}</div>`;
  bindComposerOptions(slot, options, {
    onChange: () => renderComposer(),
    onRace: () => slot.querySelector('[data-advanced-race]').classList.toggle('hidden'),
    notify: toast,
  });
  bindRaceControls(slot, renderComposer);
  $('#target-clear') &&
    ($('#target-clear').onclick = () => {
      ws.target = null;
      renderComposer();
    });
  $('#stop-btn') &&
    ($('#stop-btn').onclick = async () => {
      try {
        await api(`/api/jobs/${ws.jobId}/cancel`, { method: 'POST' });
        toast('正在停止…');
      } catch (e) {
        toast(e.message, true);
      }
    });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || running) return;
    try {
      const r = await api(`/api/projects/${ws.id}/messages`, {
        method: 'POST',
        body: { text, models: raceModels(), ...options, ...(ws.target ? { target: ws.target } : {}) },
      });
      ws.target = null;
      ws.draft = '';
      ta.value = '';
      ws.data.messages.push(r.message);
      subscribe(r.jobId);
      renderChat();
      renderComposer();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- 任务事件流 ----------
export function subscribe(jobId) {
  const ws = state.ws;
  ws.abort?.abort();
  ws.jobId = jobId;
  ws.subscribedJob = jobId;
  ws.status = ws.status || '已提交，智能体准备中…';
  renderChat();
  renderComposer();
  const ctrl = new AbortController();
  ws.abort = ctrl;
  // 用 fetch 读事件流，令牌放在请求头里（EventSource 只能把令牌放进 URL）
  (async () => {
    let ended = false;
    try {
      const res = await fetch(`/api/jobs/${jobId}/events`, { headers: { Authorization: `Bearer ${state.token}` }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`事件流 ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line || ws.closed) continue;
          const ev = JSON.parse(line.slice(5));
          handleEvent(ev);
          if (ev.type === 'end') ended = true;
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted || ws.closed) return;
    }
    if (ended || ws.closed || state.ws !== ws || ctrl.signal.aborted) return;
    // 连接断开：任务仍在服务端运行，稍后重新拉取状态并续上
    setTimeout(() => {
      if (!ws.closed && state.ws === ws) {
        ws.subscribedJob = null;
        reloadProject().catch(() => {});
      }
    }, 2000);
  })();
}

export function handleEvent(ev) {
  const ws = state.ws;
  const d = ws.data;
  switch (ev.type) {
    case 'status':
      ws.status = ev.text;
      updateWorking();
      break;
    case 'project':
      d.project.title = ev.title;
      $('#ws-title') && ($('#ws-title').textContent = ev.title);
      break;
    case 'message': {
      const m = ev.message;
      if (d.messages.some((x) => x.id === m.id)) break;
      d.messages.push(m);
      if (m.kind === 'race' && !d.races.some((r) => r.id === m.meta.raceId)) {
        d.races.push({
          id: m.meta.raceId,
          status: 'running',
          instruction: d.messages.filter((x) => x.role === 'user').at(-1)?.content,
          entries: m.meta.entries.map((e) => ({ ...e, status: 'running', created_at: Date.now() })),
        });
        ws.status = m.meta.entries.length > 1 ? `${m.meta.entries.length} 路模型正在并行开发…` : 'Alex 正在写代码…';
        setView({ type: 'race', id: m.meta.raceId });
      } else if (m.kind === 'plan') {
        ws.status = 'Mike 已完成需求拆解，正在分派给 Alex…';
        renderChat();
      } else {
        renderChat();
      }
      break;
    }
    case 'entry': {
      const race = d.races.find((r) => r.id === ev.raceId);
      if (race && !race.entries.some((e) => e.id === ev.entry.id)) race.entries.push({ ...ev.entry, created_at: Date.now() });
      if (ws.view?.type === 'race') renderViewer(true);
      break;
    }
    case 'progress': {
      ws.progress[ev.entryId] = ev;
      const hit = findEntry(ev.entryId);
      if (hit) {
        const was = hit.entry.status;
        hit.entry.status = ev.status;
        if (ev.status !== 'running') {
          hit.entry.error = ev.error;
          hit.entry.duration_ms = ev.durationMs;
          hit.entry.source = ev.source;
          if (ev.status === 'done') hit.entry.score_detail = { static: ev.static, review: ev.review };
        }
        if (was !== ev.status) {
          renderChat();
          if (ws.view?.type === 'race') renderViewer(true);
          if (ev.status === 'done') scheduleScoring();
        } else patchEntry(ev);
      }
      updateWorking();
      break;
    }
    case 'review':
      ws.status = '';
      reloadProject().then(() => toast('全部完成！自动校验打分中，选一个你最满意的版本'));
      break;
    case 'adopted':
      reloadProject({ keepView: false }).then(() => setView({ type: 'version', id: ev.version.id }));
      break;
    case 'end':
      ws.jobId = null;
      ws.status = '';
      if (ev.status !== 'done') reloadProject().catch(() => {});
      else {
        renderChat();
        renderComposer();
      }
      break;
    default:
  }
}

export function updateWorking() {
  const el = $('#chat-list .working');
  if (el) el.innerHTML = `<span class="spinner"></span>${esc(state.ws.status || '智能体正在工作…')}`;
  else renderChat();
  const steps = document.querySelectorAll('#chat-list .step');
  if (steps.length) {
    // 进度数字变化频繁，只更新对话里的步骤文本
    const ws = state.ws;
    for (const r of ws.data.races)
      for (const e of r.entries) {
        const p = ws.progress[e.id];
        if (!p || p.status !== 'running') continue;
        document.querySelectorAll('#chat-list .step.running').forEach((s) => {
          if (s.querySelector('b')?.textContent === modelLabel(e.model)) s.lastChild.textContent = ` 生成中 · ${fmtChars(p.chars)} 字`;
        });
      }
  }
}
