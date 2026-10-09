// 首页：落地页、输入框、示例、我的项目
import { showAccount, showFirstRun, showOnboarding } from './auth.js';
import { bindComposerOptions, optionsMarkup, readComposerOptions, saveComposerOptions } from './composer-options.js';
import { $, AGENTS, EXAMPLES, ICONS, api, esc, fmtTime, raceModels, state, store, toast, userAvatar } from './core.js';
import { agentAvatars, inspirationPrompts, landingSections, showcases } from './landing.js';
import { closeWorkspace } from './workspace.js';

// ======================= 首页 =======================
export function topbar() {
  return `<header class="topbar landing-nav"><a class="logo" href="#/"><span class="logo-mark">◎</span>Atoms <small>DEMO</small></a><nav aria-label="首页导航"><a href="#how-it-works" data-scroll="how-it-works">如何工作</a><a href="#inspiration" data-scroll="inspiration">设计灵感</a><a href="#team" data-scroll="team">AI 团队</a></nav><div class="nav-actions">${state.user ? `<button class="btn ghost" id="guide-btn">使用引导</button><button class="btn ghost user-chip" id="account-btn">${userAvatar(state.user.name)}<span>${esc(state.user.name)}</span></button>` : '<button class="btn ghost sm" id="login-btn">登录</button><button class="btn primary sm" id="signup-btn">免费开始 ↗</button>'}</div></header>`;
}

export function raceControls() {
  const on = state.race.on;
  const n = raceModels().length;
  return `<button type="button" class="race-toggle${on ? ' on' : ''}" data-race-toggle aria-pressed="${on}" title="开启后，系统自动挑选当前最稳定的 ${n} 个模型同时生成，自动校验打分后择优采用">
      <span class="switch"></span>${ICONS.race} 赛马${on ? ` · ${n} 路` : ''}</button>`;
}

export function bindRaceControls(root, rerender) {
  root.querySelectorAll('[data-race-toggle]').forEach(
    (b) =>
      (b.onclick = () => {
        state.race.on = !state.race.on;
        store.set('atoms.race', { on: state.race.on });
        rerender();
      }),
  );
}

export async function renderHome() {
  closeWorkspace();
  document.title = 'Atoms Demo · 一句话生成可用的应用';
  const app = $('#app');
  const options = readComposerOptions();
  app.innerHTML = `${topbar()}
  <main class="home landing-home">
    <section class="hero landing-hero"><div class="hero-glow" aria-hidden="true"></div><div class="hero-eyebrow"><span></span> YOUR IDEA. YOUR AI TEAM.</div><div class="agents-row hero-agents">${['mike', 'emma', 'bob', 'alex', 'david'].map((k) => `<span class="hero-agent"><img src="${agentAvatars[k]}" alt="${AGENTS[k].name}"></span>`).join('')}<span class="team-ready">AI 团队，已就位</span></div><h1>让你的灵感，<br>成为<em>真正能用的产品。</em></h1><p>一句话描述想法，AI 团队帮你拆解、开发与校验。<br>比较多个答案，亲手试用，再把作品分享出去。</p></section>
    <div class="creation-zone">
    <form class="composer" id="composer">
      <textarea id="prompt" aria-label="描述你想做的应用" rows="3" maxlength="2000" placeholder="告诉 Atoms 团队你想做什么，例如：做一个带优先级和截止日的项目看板，支持拖拽"></textarea>
      <div class="composer-bar">
        <div class="composer-left" id="race-slot"></div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="hint">Enter 发送 · Shift+Enter 换行</span>
          <button class="send-btn" type="submit" id="send" title="开始生成" aria-label="开始生成">${ICONS.send}</button>
        </div>
      </div>
    </form>
    <div class="examples">${EXAMPLES.map((e, i) => `<button class="example" data-ex="${i}">${e.label}</button>`).join('')}</div>
    <div class="showcase-row">不想等生成？先用用成品：${showcases.map((c) => `<a href="${c.url}" target="_blank" rel="noopener">${esc(c.title)} ↗</a>`).join('')}</div>
    </div>
    ${state.config.mockOnly ? '<div class="notice">当前为<b>演示模式</b>（未配置模型 API Key）：完整流程可体验，生成结果来自内置示例。</div>' : ''}
    <div class="section-title"><h2>我的项目</h2><span id="proj-count"></span></div>
    <div id="projects">${state.user ? '<div class="empty"><span class="spinner"></span></div>' : '<div class="empty">创建账号后，你的项目会出现在这里</div>'}</div>
    ${landingSections()}
  </main>`;

  const ta = $('#prompt');
  const draft = sessionStorage.getItem('atoms.draft');
  if (draft) ta.value = draft;
  ta.oninput = () => {
    try {
      sessionStorage.setItem('atoms.draft', ta.value);
    } catch {
      /* ignore */
    }
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  };
  app.querySelectorAll('[data-ex]').forEach(
    (b) =>
      (b.onclick = () => {
        ta.value = EXAMPLES[b.dataset.ex].text;
        ta.oninput();
        ta.focus();
      }),
  );
  const drawOptions = () => {
    const slot = $('#race-slot');
    slot.innerHTML = optionsMarkup(options, raceControls());
    bindComposerOptions(slot, options, {
      onChange: () => {
        saveComposerOptions(options);
        drawOptions();
      },
      notify: toast,
    });
    bindRaceControls(slot, () => drawOptions());
  };
  drawOptions();
  $('#account-btn') && ($('#account-btn').onclick = showAccount);
  $('#login-btn') && ($('#login-btn').onclick = () => showOnboarding({ mode: 'login' }));
  $('#signup-btn') && ($('#signup-btn').onclick = () => showOnboarding({ mode: 'register' }));
  $('#guide-btn') && ($('#guide-btn').onclick = () => showFirstRun());
  $('#bottom-start').onclick = () => {
    if (!state.user) showOnboarding({ mode: 'register' });
    else {
      $('#prompt').scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#prompt').focus();
    }
  };
  app.querySelectorAll('[data-scroll]').forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(a.dataset.scroll)
          ?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }),
  );
  app.querySelectorAll('[data-inspire]').forEach(
    (b) =>
      (b.onclick = () => {
        ta.value = inspirationPrompts[Number(b.dataset.inspire)];
        ta.oninput();
        ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ta.focus();
      }),
  );
  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    const prompt = ta.value.trim();
    if (prompt.length < 2) {
      ta.focus();
      return toast('先描述一下你想做的应用', true);
    }
    if (!state.user)
      return showOnboarding({
        afterLogin: () => {
          $('#prompt').value = prompt;
          $('#composer').requestSubmit();
        },
      });
    const btn = $('#send');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api('/api/projects', { method: 'POST', body: { prompt, models: raceModels(), ...options } });
      saveComposerOptions({ themeId: options.themeId, attachments: [] });
      try {
        sessionStorage.removeItem('atoms.draft');
      } catch {
        /* ignore */
      }
      location.hash = `#/p/${r.project.id}`;
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.innerHTML = ICONS.send;
    }
  };
  if (state.user) loadProjects();
}

export async function loadProjects() {
  const box = $('#projects');
  if (!box) return;
  try {
    const { projects } = await api('/api/projects');
    $('#proj-count') && ($('#proj-count').textContent = projects.length ? `${projects.length} 个` : '');
    if (!projects.length) {
      box.innerHTML = '<div class="empty">还没有项目。在上面输入一句话，或点一个示例试试 👆</div>';
      return;
    }
    box.innerHTML = `<div class="projects-grid">${projects
      .map(
        (p) => `
      <div class="project-card" data-id="${p.id}" tabindex="0">
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.prompt)}</p>
        <div class="meta"><span>${p.version_seq ? `Version ${p.version_seq}` : '生成中 / 待选择'}${p.share_slug ? ' · 已发布' : ''}</span><span>${fmtTime(p.updated_at)}</span></div>
        <button class="icon-btn del" data-del="${p.id}" title="删除项目">${ICONS.trash}</button>
      </div>`,
      )
      .join('')}</div>`;
    box.querySelectorAll('.project-card').forEach((c) => {
      c.onclick = () => (location.hash = `#/p/${c.dataset.id}`);
      c.onkeydown = (e) => {
        if (e.key === 'Enter') c.onclick();
      };
    });
    box.querySelectorAll('[data-del]').forEach(
      (b) =>
        (b.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('删除后项目、版本和应用数据都无法恢复，确定删除吗？')) return;
          try {
            await api(`/api/projects/${b.dataset.del}`, { method: 'DELETE' });
            toast('已删除');
            loadProjects();
          } catch (err) {
            toast(err.message, true);
          }
        }),
    );
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)} <button class="btn sm" id="retry-proj">重试</button></div>`;
    $('#retry-proj').onclick = loadProjects;
  }
}
