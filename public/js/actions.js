// 项目操作：采用、回退、Remix、重命名、下载、发布、版本历史
import { $, ICONS, api, esc, fmtTime, modelLabel, state, toast } from './core.js';
import { renderViewer } from './preview.js';
import { reloadProject, renderWorkspace, setView } from './workspace.js';

// ---------- 动作 ----------
export async function adopt(entryId) {
  const ws = state.ws;
  try {
    const r = await api(`/api/race-entries/${entryId}/adopt`, { method: 'POST' });
    toast(`已采用，生成 Version ${r.version.seq}`);
    await reloadProject({ keepView: false });
    setView({ type: 'version', id: r.version.id });
  } catch (e) {
    toast(e.message, true);
    if (ws.view?.type === 'race') renderViewer(true);
  }
}

export async function restoreVersion(versionId) {
  try {
    const r = await api(`/api/versions/${versionId}/restore`, { method: 'POST' });
    toast(`已回退，生成 Version ${r.version.seq}`);
    await reloadProject({ keepView: false });
    setView({ type: 'version', id: r.version.id });
  } catch (e) {
    toast(e.message, true);
  }
}

export async function remixVersion(versionId) {
  const ws = state.ws;
  const v = ws.data.versions.find((x) => x.id === versionId);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2>Remix Version ${v?.seq ?? ''}</h2>
    <p>以这个版本为起点复制出一个独立的新项目，之后的修改不会影响当前项目。</p>
    <label class="check-row"><input type="checkbox" id="remix-data" checked> 同时复制应用里已保存的数据</label>
    <div class="row"><button class="btn" id="remix-cancel">取消</button><button class="btn primary" id="remix-go">创建新项目</button></div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.onclick = (e) => {
    if (e.target === mask) close();
  };
  $('#remix-cancel', mask).onclick = close;
  $('#remix-go', mask).onclick = async () => {
    $('#remix-go', mask).disabled = true;
    try {
      const r = await api(`/api/versions/${versionId}/remix`, { method: 'POST', body: { copyData: $('#remix-data', mask).checked } });
      close();
      toast('已创建 Remix 项目');
      location.hash = `#/p/${r.project.id}`;
    } catch (e) {
      toast(e.message, true);
      $('#remix-go', mask).disabled = false;
    }
  };
}

export async function renameProject() {
  const ws = state.ws;
  const title = prompt('项目名称', ws.data.project.title);
  if (!title || !title.trim() || title.trim() === ws.data.project.title) return;
  try {
    await api(`/api/projects/${ws.id}`, { method: 'PATCH', body: { title: title.trim() } });
    ws.data.project.title = title.trim();
    $('#ws-title').textContent = title.trim();
    document.title = `${title.trim()} · Atoms Demo`;
  } catch (e) {
    toast(e.message, true);
  }
}

export async function downloadCurrent() {
  const ws = state.ws;
  const id = ws.data.project.current_version_id;
  if (!id) return;
  try {
    const { html, seq } = await api(`/api/versions/${id}/html`);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${ws.data.project.title.replace(/[\\/:*?"<>|]/g, '_')}-v${seq}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast(e.message, true);
  }
}

export async function publish() {
  const ws = state.ws;
  const btn = $('#ws-publish');
  btn.disabled = true;
  try {
    const r = await api(`/api/projects/${ws.id}/publish`, { method: 'POST' });
    ws.data.project.share_slug = r.slug;
    ws.data.project.published_version_id = ws.data.project.current_version_id;
    const url = `${location.origin}${r.url}`;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <h2>🎉 已发布 Version ${r.seq}</h2>
      <p>任何人打开链接都能直接使用这个应用，每位访客的数据各自独立保存。之后修改了项目，记得再点「更新发布」。</p>
      <div class="code-box">${esc(url)}</div>
      <div class="row"><button class="btn danger" id="pub-off">取消发布</button><button class="btn" id="pub-copy">复制链接</button><a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">打开</a><button class="btn primary" id="pub-ok">完成</button></div>
    </div>`;
    document.body.appendChild(mask);
    mask.onclick = (e) => {
      if (e.target === mask) mask.remove();
    };
    $('#pub-ok', mask).onclick = () => mask.remove();
    $('#pub-off', mask).onclick = async () => {
      if (!confirm('取消发布后链接立即失效，访客数据也会清除。确定吗？')) return;
      try {
        await api(`/api/projects/${ws.id}/publish`, { method: 'DELETE' });
        ws.data.project.share_slug = null;
        ws.data.project.published_version_id = null;
        mask.remove();
        toast('已取消发布，旧链接已失效');
        renderWorkspace();
      } catch (e) {
        toast(e.message, true);
      }
    };
    $('#pub-copy', mask).onclick = () =>
      navigator.clipboard.writeText(url).then(
        () => toast('链接已复制'),
        () => toast('复制失败，请手动复制', true),
      );
    btn.textContent = '已发布';
  } catch (e) {
    toast(e.message, true);
  }
  btn.disabled = false;
}

export function renderDrawer() {
  const ws = state.ws;
  const slot = $('#drawer-slot');
  const { versions, project } = ws.data;
  slot.innerHTML = `<aside class="drawer">
    <div class="drawer-head"><h3>版本历史</h3><button class="icon-btn" id="drawer-close">✕</button></div>
    <div class="drawer-list">${
      versions.length
        ? versions
            .map(
              (v) => `
      <div class="v-item${v.id === project.current_version_id ? ' current' : ''}" data-v="${v.id}">
        <span class="v-ico" style="width:32px;height:32px;border-radius:9px;background:var(--primary-soft);color:var(--primary);display:grid;place-items:center;font-weight:800;font-size:12px">V${v.seq}</span>
        <div class="v-text"><b>${esc(v.title)}</b><span>${esc(v.source === 'restore' ? '回退' : v.source === 'remix' ? 'Remix' : modelLabel(v.model || ''))} · ${fmtTime(v.created_at)}${v.id === project.published_version_id ? ' · 已发布' : ''}</span></div>
        ${v.id === project.current_version_id ? '<span class="badge primary">当前</span>' : ''}
        <button class="icon-btn" data-remix="${v.id}" title="Remix 成新项目">${ICONS.remix}</button>
      </div>`,
            )
            .join('')
        : '<div class="empty">还没有版本</div>'
    }</div>
  </aside>`;
  $('#drawer-close').onclick = () => {
    ws.drawer = false;
    slot.remove();
  };
  slot.querySelectorAll('[data-remix]').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        remixVersion(b.dataset.remix);
      }),
  );
  slot.querySelectorAll('[data-v]').forEach(
    (el) =>
      (el.onclick = () => {
        ws.drawer = false;
        setView({ type: 'version', id: el.dataset.v });
      }),
  );
}
