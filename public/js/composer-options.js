import { THEMES, FILE_LIMITS, validateAttachments } from './generation-presets.js';
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function readComposerOptions(project) {
  if (project) return { themeId: project.theme_id || 'default', attachments: JSON.parse(project.attachments || '[]') };
  try {
    const saved = JSON.parse(sessionStorage.getItem('atoms.composer-options') || '{}');
    return {
      themeId: THEMES.some((t) => t.id === saved.themeId) ? saved.themeId : 'default',
      attachments: validateAttachments(saved.attachments || []),
    };
  } catch {
    return { themeId: 'default', attachments: [] };
  }
}
export function saveComposerOptions(options) {
  try {
    sessionStorage.setItem('atoms.composer-options', JSON.stringify(options));
  } catch {
    /* 仍可本次使用 */
  }
}
export function optionsMarkup(options) {
  const theme = THEMES.find((t) => t.id === options.themeId) || THEMES[0];
  return `<div class="generation-options"><div class="option-anchor"><button type="button" class="option-btn" data-options-plus aria-label="更多生成选项" aria-expanded="false">＋</button><div class="options-popover hidden" data-options-menu><b>更多生成选项</b><button type="button" data-add-file>↗ 添加文本附件</button><button type="button" data-race-open>⚑ 赛马与模型设置</button><small>TXT / Markdown / JSON · 最多3个<br>附件会传给模型，请勿包含密码或密钥。</small></div></div><div class="option-anchor"><button type="button" class="option-btn" data-theme-open aria-expanded="false">◉ ${escape(theme.name)}⌄</button><div class="options-popover theme-popover hidden" data-theme-menu><label>选择生成应用的主题<input type="search" class="field" data-theme-search placeholder="搜索主题" aria-label="搜索主题"></label><div data-theme-list>${THEMES.map((t) => `<button type="button" data-theme="${t.id}" aria-pressed="${options.themeId === t.id}"><span>${t.name}</span><span class="theme-dots"><i style="background:${t.primary}"></i><i style="background:${t.bg}"></i><i style="background:${t.text}"></i></span></button>`).join('')}</div><small>应用于下次生成或修改，不会清空数据。</small></div></div><input type="file" accept=".txt,.md,.json,text/plain,text/markdown,application/json" multiple data-file-input hidden></div><div class="file-chips">${options.attachments.map((f, i) => `<span>${escape(f.name)} <small>${f.text.length}字</small><button type="button" data-remove-file="${i}" aria-label="移除附件 ${escape(f.name)}">×</button></span>`).join('')}</div>`;
}
export function bindComposerOptions(root, options, { onChange, onRace, notify }) {
  const plus = root.querySelector('[data-options-plus]'),
    theme = root.querySelector('[data-theme-open]');
  const menu = root.querySelector('[data-options-menu]'),
    themes = root.querySelector('[data-theme-menu]');
  const close = () => {
    menu.classList.add('hidden');
    themes.classList.add('hidden');
    plus.setAttribute('aria-expanded', 'false');
    theme.setAttribute('aria-expanded', 'false');
  };
  const toggle = (el, button) => {
    const opening = el.classList.contains('hidden');
    close();
    el.classList.toggle('hidden', !opening);
    button.setAttribute('aria-expanded', String(opening));
    if (opening && el === themes) root.querySelector('[data-theme-search]').focus();
  };
  plus.onclick = () => toggle(menu, plus);
  theme.onclick = () => toggle(themes, theme);
  root.onkeydown = (e) => {
    if (e.key === 'Escape') {
      close();
      theme.focus();
    }
  };
  // 注册在本次控件根上，外部点击通过捕获处理；重绘时移除旧监听，避免累积。
  const outside = (e) => {
    if (!root.isConnected) {
      root.__disposeOptions?.();
      return;
    }
    if (!root.contains(e.target)) close();
  };
  root.__disposeOptions?.();
  document.addEventListener('pointerdown', outside);
  root.__disposeOptions = () => document.removeEventListener('pointerdown', outside);
  root.querySelector('[data-race-open]').onclick = () => {
    close();
    onRace();
  };
  root.querySelector('[data-add-file]').onclick = () => {
    close();
    root.querySelector('[data-file-input]').click();
  };
  root.querySelector('[data-theme-search]').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    root.querySelectorAll('[data-theme]').forEach((b) => (b.hidden = !b.textContent.toLowerCase().includes(q)));
  };
  root.querySelectorAll('[data-theme]').forEach(
    (b) =>
      (b.onclick = () => {
        options.themeId = b.dataset.theme;
        onChange();
      }),
  );
  root.querySelectorAll('[data-remove-file]').forEach(
    (b) =>
      (b.onclick = () => {
        options.attachments.splice(Number(b.dataset.removeFile), 1);
        onChange();
      }),
  );
  root.querySelector('[data-file-input]').onchange = async (e) => {
    try {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      if (files.length + options.attachments.length > FILE_LIMITS.count) throw Error('最多添加3个文本附件');
      const added = [];
      for (const f of files) {
        if (f.size > FILE_LIMITS.bytes) throw Error('单文件不能超过32KB');
        added.push({ name: f.name, text: await f.text() });
      }
      options.attachments = validateAttachments([...options.attachments, ...added]);
      onChange();
      notify('附件已加入，将在发送后用于生成');
    } catch (error) {
      notify(error.message, true);
    } finally {
      e.target.value = '';
    }
  };
}
