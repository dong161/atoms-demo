// 预览区：应用查看器、Console、点选修改、一键修复
import { adopt, downloadCurrent, remixVersion, restoreVersion } from './actions.js';
import { $, ICONS, api, esc, modelLabel, raceModels, state, store, toast } from './core.js';
import { renderRace } from './race.js';
import { mountPreview } from './sandbox.js';
import { findEntry, renderChat, renderComposer, setView, subscribe } from './workspace.js';

// ---------- 预览区 ----------
export function renderViewer(force = false) {
  const ws = state.ws;
  const box = $('#viewer');
  if (!box) return;
  const v = ws.view;
  const key = JSON.stringify(v) + ws.device;
  if (!force && ws.previewKey === key && ws.preview) return;
  ws.previewKey = key;
  ws.preview?.destroy();
  ws.preview = null;
  if (v.type === 'race') return renderRace(box);
  if (v.type === 'empty') {
    box.innerHTML = `<div class="placeholder"><div class="big">🛠️</div><h3>${ws.jobId ? '智能体正在工作' : '还没有版本'}</h3><p>${ws.jobId ? 'Mike 正在拆解需求，马上交给 Alex 开发。' : '在对话里描述你的需求开始生成。'}</p></div>`;
    return;
  }
  renderPreview(box);
}

export async function renderPreview(box) {
  const ws = state.ws;
  const v = ws.view;
  const d = ws.data;
  let label,
    banner = '',
    html,
    kv = null,
    entryId = null;
  if (v.type === 'version') {
    const ver = d.versions.find((x) => x.id === v.id);
    const cur = d.versions.find((x) => x.id === d.project.current_version_id);
    label = `Version ${ver.seq} · ${esc(ver.title)}${ver.model ? ` · ${esc(modelLabel(ver.model))}` : ''}`;
    if (ver.id !== d.project.current_version_id) {
      banner = `<div class="viewer-banner">正在预览历史版本 Version ${ver.seq}（当前为 Version ${cur?.seq ?? '-'}）
        <button class="btn sm" id="restore-btn">回退到此版本</button><button class="btn sm" id="remix-btn">${ICONS.remix} Remix 成新项目</button><button class="btn sm ghost" id="back-current">回到当前版本</button></div>`;
    }
    kv = {
      load: async () => (await api(`/api/projects/${ws.id}/kv`)).data,
      save: (body) => api(`/api/projects/${ws.id}/kv`, { method: 'POST', body }),
    };
  } else {
    const hit = findEntry(v.id);
    entryId = v.id;
    label = `候选 · ${esc(modelLabel(hit.entry.model))}`;
    const adopted = hit.race.adopted_entry_id === v.id;
    banner = `<div class="viewer-banner">正在全屏试用赛马候选（试用数据不保存）
      ${adopted ? '<span class="badge ok">已采用</span>' : '<button class="btn sm primary" id="adopt-btn">采用此版本</button>'}
      <button class="btn sm ghost" id="back-race">返回赛马对比</button></div>`;
  }
  const errCount = ws.consoleLines.filter((l) => l.level === 'error').length;
  box.innerHTML = `
    <div class="viewer-toolbar">
      <button class="icon-btn${ws.device === 'desktop' ? ' on' : ''}" data-device="desktop" title="桌面视图">${ICONS.desktop}</button>
      <button class="icon-btn${ws.device === 'mobile' ? ' on' : ''}" data-device="mobile" title="手机视图">${ICONS.mobile}</button>
      <button class="icon-btn" id="vt-refresh" title="刷新预览">${ICONS.refresh}</button>
      <div class="seg" role="tablist" aria-label="查看方式"><button role="tab" data-vmode="preview" aria-selected="${ws.viewerMode !== 'code'}" class="${ws.viewerMode !== 'code' ? 'on' : ''}">预览</button><button role="tab" data-vmode="code" aria-selected="${ws.viewerMode === 'code'}" class="${ws.viewerMode === 'code' ? 'on' : ''}">代码</button></div>
      <span class="label">${label}</span><span class="spacer"></span>
      ${
        v.type === 'version' && v.id === d.project.current_version_id
          ? `<button class="btn sm ghost" id="vt-fix" hidden>${ICONS.wrench}<span>修复报错</span></button>
      <button class="btn sm ghost${ws.picking ? ' on' : ''}" id="vt-pick" title="在预览里点一个元素，再用对话只修改它">${ICONS.pick}<span class="wide">选择元素</span></button>`
          : ''
      }
      ${
        v.type === 'version'
          ? `<button class="icon-btn" id="vt-reset" title="清空这个应用保存的数据">${ICONS.eraser}</button>
      <button class="btn sm ghost" id="vt-open" title="在新标签页中全屏运行，数据与这里同步">${ICONS.open}<span class="wide">新标签页打开</span></button>
      ${v.id === d.project.current_version_id ? `<button class="btn sm ghost" id="vt-download" title="导出为可独立运行的 HTML 文件">${ICONS.download}<span class="wide">导出</span></button>` : ''}`
          : ''
      }
      <button class="icon-btn${ws.consoleOpen ? ' on' : ''}" id="vt-console" title="Console">${ICONS.console}${errCount ? `<sup style="color:var(--err);font-weight:700">${errCount}</sup>` : ''}</button>
    </div>
    ${banner}
    <div class="viewer-main"><div class="frame-wrap ${ws.device}" id="frame-wrap"><div class="placeholder"><span class="spinner"></span></div></div></div>
    <div class="console ${ws.consoleOpen ? '' : 'hidden'}" id="console"></div>`;
  box.querySelectorAll('[data-device]').forEach(
    (b) =>
      (b.onclick = () => {
        ws.device = b.dataset.device;
        store.set('atoms.device', ws.device);
        renderViewer(true);
      }),
  );
  $('#vt-refresh').onclick = () => renderViewer(true);
  box.querySelectorAll('[data-vmode]').forEach(
    (b) =>
      (b.onclick = () => {
        ws.viewerMode = b.dataset.vmode;
        renderViewer(true);
      }),
  );
  $('#vt-console').onclick = () => {
    ws.consoleOpen = !ws.consoleOpen;
    $('#console').classList.toggle('hidden', !ws.consoleOpen);
    $('#vt-console').classList.toggle('on', ws.consoleOpen);
    renderConsole();
  };
  $('#vt-open') &&
    ($('#vt-open').onclick = () =>
      window.open(`/preview?project=${encodeURIComponent(ws.id)}&version=${encodeURIComponent(v.id)}`, '_blank'));
  $('#vt-download') && ($('#vt-download').onclick = downloadCurrent);
  $('#vt-reset') &&
    ($('#vt-reset').onclick = async () => {
      if (!confirm('清空这个应用保存的所有数据（恢复到初始示例数据）？')) return;
      try {
        await api(`/api/projects/${ws.id}/kv`, { method: 'POST', body: { clear: true } });
        toast('已清空应用数据');
        renderViewer(true);
      } catch (e) {
        toast(e.message, true);
      }
    });
  $('#restore-btn') && ($('#restore-btn').onclick = () => restoreVersion(v.id));
  $('#remix-btn') && ($('#remix-btn').onclick = () => remixVersion(v.id));
  $('#vt-pick') &&
    ($('#vt-pick').onclick = () => {
      if (ws.jobId) return toast('等当前任务完成后再选择元素', true);
      ws.picking = !ws.picking;
      $('#vt-pick').classList.toggle('on', ws.picking);
      ws.preview?.setPick(ws.picking);
      if (ws.picking) toast('在预览里点一下要修改的元素（Esc 取消）');
    });
  $('#vt-fix') && ($('#vt-fix').onclick = fixErrors);
  $('#back-current') && ($('#back-current').onclick = () => setView({ type: 'version', id: d.project.current_version_id }));
  $('#back-race') && ($('#back-race').onclick = () => setView({ type: 'race', id: findEntry(v.id).race.id }));
  $('#adopt-btn') && ($('#adopt-btn').onclick = () => adopt(entryId));
  renderConsole();

  // 每次渲染一个递增序号：同一视图可能被连续渲染两次（例如采用后 reload + setView），只有最后一次能挂载
  const renderSeq = (ws.renderSeq = (ws.renderSeq || 0) + 1);
  const stale = () => ws.closed || ws.renderSeq !== renderSeq;
  try {
    html = v.type === 'version' ? (await api(`/api/versions/${v.id}/html`)).html : (await api(`/api/race-entries/${v.id}/html`)).html;
  } catch (e) {
    if (!stale()) $('#frame-wrap').innerHTML = `<div class="placeholder"><h3>加载失败</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (stale()) return;
  if (ws.viewerMode === 'code') {
    ws.preview = null;
    $('#frame-wrap').className = 'frame-wrap code-mode';
    $('#frame-wrap').innerHTML = codeView(html, `index.html`);
    $('#code-copy').onclick = () =>
      navigator.clipboard.writeText(html).then(
        () => toast('代码已复制'),
        () => toast('复制失败，请手动选择复制', true),
      );
    return;
  }
  ws.consoleLines = [];
  ws.picking = false;
  renderConsole();
  const preview = await mountPreview($('#frame-wrap'), html, {
    kv,
    onConsole: pushConsole,
    onReady: () => $('#frame-wrap .preview-loading')?.remove(),
    onPicked: (target) => {
      ws.picking = false;
      $('#vt-pick')?.classList.remove('on');
      if (!target) return;
      ws.target = target;
      ws.tab = 'chat';
      document.querySelector('.ws-body')?.setAttribute('data-tab', 'chat');
      document.querySelectorAll('.ws-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'chat'));
      renderComposer();
      $('#chat-input')?.focus();
    },
  });
  // 加载期间用户可能已切换版本/设备：过期的预览直接销毁，不能覆盖当前引用
  if (stale()) return preview.destroy();
  ws.preview = preview;
  // 应用脚本启动前显示加载提示，避免预览区短暂空白被误认为失败
  if (!preview.ready) {
    const loading = document.createElement('div');
    loading.className = 'preview-loading';
    loading.innerHTML = '<span class="spinner"></span> 正在启动应用…';
    $('#frame-wrap')?.appendChild(loading);
    setTimeout(() => loading.remove(), 8000);
  }
}

export function pushConsole(line) {
  const ws = state.ws;
  if (!ws) return;
  ws.consoleLines.push({ ...line, at: Date.now() });
  if (line.level === 'error' && line.text.startsWith('数据同步失败')) toast('应用数据暂时没能保存到云端，正在自动重试，请检查网络', true);
  if (ws.consoleLines.length > 300) ws.consoleLines.shift();
  updateFixButton();
  if (line.level === 'error' && !line.text.startsWith('数据同步失败')) maybeAutoFix();
  if (line.level === 'error' && !ws.consoleOpen) {
    const btn = $('#vt-console');
    const n = ws.consoleLines.filter((l) => l.level === 'error').length;
    if (btn) btn.innerHTML = `${ICONS.console}<sup style="color:var(--err);font-weight:700">${n}</sup>`;
  }
  renderConsole();
}
export function updateFixButton() {
  const ws = state.ws;
  const btn = $('#vt-fix');
  if (!btn || !ws) return;
  const n = ws.consoleLines.filter((l) => l.level === 'error').length;
  btn.hidden = !n || !!ws.jobId;
  btn.querySelector('span').textContent = `让 Alex 修复 ${n} 个报错`;
}

// 自动修复闭环：刚生成的版本一启动就报错时，不等用户发现，自动交给 Alex 修一轮。
// 每个版本只自动修一次；如果这个版本本身就是修复的结果，不再连环自动修复，改为提示用户。
const AUTO_FIX_WINDOW_MS = 15 * 60_000;
let autoFixTimer = null;
function maybeAutoFix() {
  const ws = state.ws;
  const d = ws?.data;
  if (!d || ws.jobId || ws.view?.type !== 'version' || ws.view.id !== d.project.current_version_id) return;
  const ver = d.versions.find((v) => v.id === d.project.current_version_id);
  if (!ver || Date.now() - ver.created_at > AUTO_FIX_WINDOW_MS) return;
  const key = `atoms.autofix.${ver.id}`;
  if (store.get(key)) return;
  const lastUser = [...d.messages].reverse().find((m) => m.role === 'user');
  if (lastUser?.meta?.fixErrors) return;
  clearTimeout(autoFixTimer);
  // 稍等片刻收集同一轮启动里的其它报错，再一起交给 Alex
  autoFixTimer = setTimeout(() => {
    if (state.ws !== ws || ws.jobId || store.get(key)) return;
    store.set(key, true);
    toast('检测到新版本运行报错，Alex 正在自动修复');
    fixErrors({ auto: true });
  }, 2500);
}

// 一键修复（对应 Atoms 的 Resolve）：把预览控制台的报错交给 Alex
export async function fixErrors({ auto = false } = {}) {
  const ws = state.ws;
  const errors = [...new Set(ws.consoleLines.filter((l) => l.level === 'error').map((l) => l.text))].slice(0, 5);
  if (!errors.length || ws.jobId) return;
  try {
    const r = await api(`/api/projects/${ws.id}/messages`, {
      method: 'POST',
      body: { fixErrors: errors, models: raceModels().slice(0, 1), ...(ws.generation || {}) },
    });
    ws.data.messages.push(r.message);
    subscribe(r.jobId);
    renderChat();
    renderComposer();
    if (!auto) toast('已交给 Alex 修复');
  } catch (e) {
    toast(e.message, true);
  }
}

export function renderConsole() {
  const el = $('#console');
  if (!el || el.classList.contains('hidden')) return;
  const lines = state.ws.consoleLines;
  el.innerHTML = lines.length
    ? lines.map((l) => `<div class="line ${esc(l.level)}">[${esc(l.level)}] ${esc(l.text)}</div>`).join('')
    : '<div class="line">暂无输出。应用里的 console 输出和报错会显示在这里。</div>';
  el.scrollTop = el.scrollHeight;
}

// ---------- 只读代码视图（轻量语法高亮：先转义再着色，不会执行或注入代码） ----------
function highlight(line) {
  const e = esc(line);
  if (/^\s*(\/\/|\/\*|\*|&lt;!--)/.test(e)) return `<span class="tk-c">${e}</span>`;
  // 单次扫描：字符串、标签名、关键字互不嵌套，避免在已插入的 <span> 上二次替换
  return e.replace(
    /(&quot;.*?&quot;|&#39;.*?&#39;|&#x27;.*?&#x27;|`[^`]*`)|(&lt;\/?)([a-zA-Z][\w-]*)|\b(const|let|var|function|return|if|else|for|while|new|class|import|export|async|await|try|catch|switch|case|break|of|in|true|false|null|undefined)\b/g,
    (m, str, lt, tag, kw) =>
      str ? `<span class="tk-s">${str}</span>` : lt ? `${lt}<span class="tk-t">${tag}</span>` : `<span class="tk-k">${kw}</span>`,
  );
}
function codeView(html, name) {
  const rows = String(html).split('\n');
  return `<div class="code-view"><div class="code-head"><span class="code-tab">${esc(name)}</span><small>${rows.length} 行 · ${(html.length / 1024).toFixed(1)} KB · 只读</small><span class="spacer"></span><button class="btn sm ghost" id="code-copy">⧉ 复制代码</button></div><pre class="code-body"><code>${rows.map((r, i) => `<span class="ln">${i + 1}</span>${highlight(r)}`).join('\n')}</code></pre></div>`;
}
