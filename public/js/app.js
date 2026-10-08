import { mountPreview, probeApp } from './sandbox.js';
import { readComposerOptions, saveComposerOptions, optionsMarkup, bindComposerOptions } from './composer-options.js';
import { agentAvatars, landingSections, inspirationPrompts, showcases } from './landing.js';

// ======================= 基础工具 =======================
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* 隐私模式等情况下忽略 */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const AGENTS = {
  mike: { name: 'Mike', role: '组长', color: '#6d5efc', initial: 'M' },
  alex: { name: 'Alex', role: '工程师', color: '#0ea5e9', initial: 'A' },
  emma: { name: 'Emma', role: '产品经理', color: '#f97316', initial: 'E' },
  bob: { name: 'Bob', role: '架构师', color: '#10b981', initial: 'B' },
  david: { name: 'David', role: '数据分析', color: '#e11d48', initial: 'D' },
  system: { name: '系统', role: '', color: '#9aa0b5', initial: 'S' },
};

const EXAMPLES = [
  { label: '📋 项目看板', text: '做一个项目看板：任务有优先级和截止日期，可以在待办/进行中/已完成之间拖拽，逾期任务高亮' },
  { label: '🏠 房贷计算器', text: '做一个房贷计算器，支持等额本息和等额本金，能对比提前还款能省多少利息，并保存最近的计算记录' },
  { label: '👤 个人主页', text: '做一个可在线编辑的个人主页：头像、简介、技能标签、项目经历和联系方式，编辑后自动保存' },
  { label: '💧 喝水打卡', text: '做一个每日喝水打卡应用，可以设置每日目标，点击记录一杯水，显示本周完成情况的柱状图' },
];

let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), err ? 4000 : 2200);
}

const fmtTime = (t) => {
  const d = new Date(Number(t));
  const diff = Date.now() - d;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return (
    d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  );
};
const fmtChars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const modelLabel = (m) => (m === 'mock' ? '演示模型' : m);

function avatar(key, size) {
  const a = AGENTS[key] || AGENTS.system;
  const style = `background:${a.color}${size ? `;width:${size}px;height:${size}px` : ''}`;
  return `<span class="avatar" style="${style}" title="${esc(a.name)}${a.role ? ' · ' + esc(a.role) : ''}">${a.initial}</span>`;
}
function userAvatar(name) {
  const colors = ['#6d5efc', '#0ea5e9', '#10b981', '#f97316', '#e11d48', '#8b5cf6'];
  const c = colors[[...(name || '?')].reduce((s, ch) => s + ch.charCodeAt(0), 0) % colors.length];
  return `<span class="avatar" style="background:${c}">${esc([...(name || '?')][0].toUpperCase())}</span>`;
}

const ICONS = {
  send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  desktop:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  mobile:
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>',
  open: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  console:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  history:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/></svg>',
  trash:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  download:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v12M6 10l6 6 6-6M4 20h16"/></svg>',
  race: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  pick: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 17 2.5-7.5L21 11z"/></svg>',
  wrench:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>',
  remix:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/></svg>',
  eraser:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 20H9L4 15l10-10 7 7-6 6M8 11l6 6"/></svg>',
};

// ======================= API =======================
const state = {
  token: store.get('atoms.token'),
  user: null,
  config: { mockOnly: true, models: ['mock'], defaultRace: ['mock', 'mock'], maxModels: 3 },
  race: store.get('atoms.race', { on: true, models: null }),
  ws: null,
};

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('网络连接失败，请检查网络后重试'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.user) {
      logout(true);
    }
    throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { status: res.status });
  }
  return data;
}

function raceModels() {
  const avail = state.config.models;
  let list = (state.race.models || state.config.defaultRace).filter((m) => avail.includes(m));
  if (state.config.mockOnly) list = state.config.defaultRace;
  if (!list.length) list = state.config.defaultRace;
  return state.race.on ? list.slice(0, state.config.maxModels) : [list[0] || avail[0]];
}

// ======================= 账号（注册 / 恢复码） =======================
function logout(expired = false) {
  state.token = null;
  state.user = null;
  store.del('atoms.token');
  if (expired) toast('登录已失效，请重新进入', true);
  location.hash = '#/';
  render();
}

function accessibleDialog(mask, close) {
  const previous = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    if (e.key === 'Tab') {
      const items = [...mask.querySelectorAll('button,input,select,textarea,a[href]')].filter(
        (el) => !el.disabled && el.getClientRects().length,
      );
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  mask.addEventListener('keydown', onKey);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  const old = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    mask.removeEventListener('keydown', onKey);
    mask.remove();
    document.body.style.overflow = old;
    previous?.focus();
  };
}
function showOnboarding({ afterLogin, mode = 'register' } = {}) {
  if (document.querySelector('.auth-mask')) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask auth-mask';
  let remove,
    busy = false;
  const close = () => {
    if (!busy) remove();
  };
  const draw = () => {
    mask.innerHTML = `<div class="auth-shell" role="dialog" aria-modal="true" aria-labelledby="auth-title"><aside class="auth-art"><div class="auth-brand">◎ Atoms <small>DEMO</small></div><div class="auth-orbit">${['mike', 'emma', 'alex'].map((k) => `<img src="${agentAvatars[k]}" alt="${AGENTS[k].name}">`).join('')}</div><h2>一个想法，<br>一整个 AI 团队。</h2><p>从第一句话，到第一个能点击的产品。你的创作之旅，从这里开始。</p><small>独立演示项目 · 非 Atoms 官方账号</small></aside><section class="auth-content"><button class="icon-btn auth-close" id="auth-close" aria-label="关闭登录窗口">✕</button><div class="auth-tabs"><button type="button" data-auth-mode="login" class="${mode === 'login' ? 'active' : ''}">登录</button><button type="button" data-auth-mode="register" class="${mode === 'register' ? 'active' : ''}">注册</button></div><h2 id="auth-title">${{ login: '欢迎回来', register: '开启你的创作之旅', guest: '先体验，再决定', restore: '恢复你的项目' }[mode]}</h2><p>${{ login: '登录后，继续你的项目和创作。', register: '创建账号，让你的想法有一个长期的家。', guest: '只需昵称，无需邮箱。请保存账号恢复码。', restore: '使用之前保存的恢复码，不会新建账号。' }[mode]}</p><form id="auth-form">${mode === 'register' || mode === 'guest' ? '<label for="auth-name">昵称</label><input class="field" id="auth-name" name="nickname" autocomplete="nickname" maxlength="30" required placeholder="怎么称呼你？">' : ''}${mode === 'login' || mode === 'register' ? `<label for="auth-email">邮箱</label><input class="field" id="auth-email" type="email" maxlength="254" autocomplete="email" required placeholder="you@example.com"><label for="auth-password">密码</label><div class="password-field"><input class="field" id="auth-password" type="password" minlength="10" maxlength="128" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required placeholder="至少 10 个字符"><button type="button" id="password-eye" aria-label="显示密码">显示</button></div>` : ''}${mode === 'restore' ? '<label for="auth-code">账号恢复码</label><input class="field" id="auth-code" type="password" autocomplete="off" required placeholder="粘贴恢复码">' : ''}<div class="auth-error" id="auth-error" role="alert"></div><button class="btn primary auth-submit" type="submit">${{ login: '登录并继续', register: '创建账号', guest: '开始体验', restore: '恢复账号' }[mode]} ↗</button></form><div class="auth-alternatives"><button class="link" data-auth-mode="guest">仅用昵称快速体验</button><span>·</span><button class="link" data-auth-mode="restore">用恢复码登录</button></div><p class="auth-disclaimer">邮箱仅作为账号标识，暂不支持邮件验证或邮件找回密码。已有昵称账号请使用恢复码登录。</p></section></div>`;
    $('#auth-close', mask).onclick = close;
    mask.querySelectorAll('[data-auth-mode]').forEach(
      (b) =>
        (b.onclick = () => {
          if (!busy) {
            mode = b.dataset.authMode;
            draw();
          }
        }),
    );
    const pw = $('#auth-password', mask);
    if (pw)
      $('#password-eye', mask).onclick = () => {
        pw.type = pw.type === 'password' ? 'text' : 'password';
        $('#password-eye', mask).textContent = pw.type === 'password' ? '显示' : '隐藏';
        $('#password-eye', mask).setAttribute('aria-label', pw.type === 'password' ? '显示密码' : '隐藏密码');
      };
    $('#auth-form', mask).onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      const buttons = [...mask.querySelectorAll('button')];
      buttons.forEach((b) => (b.disabled = true));
      $('#auth-error', mask).textContent = '';
      const oldToken = state.token;
      try {
        let r;
        if (mode === 'restore') {
          state.token = $('#auth-code', mask).value.trim();
          r = await api('/api/me');
          r.token = state.token;
        } else if (mode === 'guest') r = await api('/api/users', { method: 'POST', body: { name: $('#auth-name', mask).value.trim() } });
        else
          r = await api(`/api/auth/${mode}`, {
            method: 'POST',
            body: {
              email: $('#auth-email', mask).value.trim(),
              password: pw.value,
              ...(mode === 'register' ? { name: $('#auth-name', mask).value.trim() } : {}),
            },
          });
        state.token = r.token;
        state.user = r.user;
        store.set('atoms.token', r.token);
        busy = false;
        remove();
        await render();
        toast(`欢迎${mode === 'login' || mode === 'restore' ? '回来' : ''}，${r.user.name}`);
        if (mode === 'guest' || mode === 'register') showFirstRun({ afterDone: afterLogin });
        else afterLogin?.();
      } catch (err) {
        state.token = oldToken;
        $('#auth-error', mask).textContent = err.status === 401 ? '邮箱、密码或恢复码不正确' : err.message;
        busy = false;
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    const first = mask.querySelector('input');
    first?.focus();
  };
  document.body.appendChild(mask);
  remove = accessibleDialog(mask, close);
  draw();
}
function showFirstRun({ afterDone } = {}) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  let step = 0,
    choice = 0,
    remove;
  const finish = () => {
    store.set(`atoms.onboarded.${state.user.id}`, true);
    remove();
    afterDone?.();
  };
  const titles = ['先选一个小目标', '认识你的创作流程', '准备好第一个想法'];
  const draw = () => {
    mask.innerHTML = `<div class="modal first-run" role="dialog" aria-modal="true" aria-labelledby="setup-title"><div class="setup-progress">${titles.map((t, i) => `<span class="${i <= step ? 'active' : ''}"></span>`).join('')}</div><span class="section-eyebrow">FIRST STEPS · ${step + 1} / 3</span><h2 id="setup-title">${titles[step]}</h2>${step === 0 ? `<p>从一个你真的会用的工具开始。这里不会立即调用模型。</p><div class="setup-choices">${EXAMPLES.map((e, i) => `<button class="${choice === i ? 'selected' : ''}" data-choice="${i}" aria-pressed="${choice === i}">${e.label}</button>`).join('')}</div>` : step === 1 ? '<p>描述需求 → 多模型生成 → 比较候选 → 采用并预览 → 对话修改 → 发布分享。</p><div class="setup-tip">模型生成可能需要几分钟。你可以查看每路进度；如果中断，保留已有版本再重试。</div>' : '<p>提示已为你准备好。完成后会填入首页输入框，你可以编辑，确认后再点发送。</p><div class="setup-tip">' + esc(EXAMPLES[choice].text) + '</div>'}<div class="row"><button class="btn ghost" id="setup-skip">暂时跳过</button>${step > 0 ? '<button class="btn" id="setup-back">上一步</button>' : ''}<button class="btn primary" id="setup-next">${step === 2 ? '完成，开始创作' : '下一步'}</button></div></div>`;
    $('#setup-skip', mask).onclick = finish;
    $('#setup-back', mask) &&
      ($('#setup-back', mask).onclick = () => {
        step--;
        draw();
      });
    mask.querySelectorAll('[data-choice]').forEach(
      (b) =>
        (b.onclick = () => {
          choice = Number(b.dataset.choice);
          draw();
        }),
    );
    $('#setup-next', mask).onclick = () => {
      if (step < 2) {
        step++;
        draw();
      } else {
        if (!afterDone) {
          const ta = $('#prompt');
          if (ta) {
            ta.value = EXAMPLES[choice].text;
            ta.oninput?.();
          }
        }
        finish();
      }
    };
    $('#setup-next', mask).focus();
  };
  document.body.appendChild(mask);
  remove = accessibleDialog(mask, finish);
  draw();
}

function showAccount() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h2>账号</h2>
      <p>昵称：<b>${esc(state.user?.name)}</b><br>换设备时，用下面的恢复码登录即可找回所有项目。请像密码一样保管它。</p>
      <button class="btn sm" id="ac-reveal">显示恢复码 / 当前会话码</button><div class="code-box hidden" id="ac-secret">${esc(state.token)}</div><p>邮箱账号也可用密码重新登录。登录会话码有效期7天；注册时的恢复码请私下保管。</p>
      <div class="row">
        <button class="btn danger" id="ac-out">退出登录</button>
        <button class="btn" id="ac-copy">复制恢复码</button>
        <button class="btn primary" id="ac-close">完成</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.onclick = (e) => {
    if (e.target === mask) mask.remove();
  };
  $('#ac-reveal', mask).onclick = () => {
    $('#ac-secret', mask).classList.toggle('hidden');
  };
  $('#ac-close', mask).onclick = () => mask.remove();
  $('#ac-copy', mask).onclick = () =>
    navigator.clipboard.writeText(state.token).then(
      () => toast('已复制恢复码'),
      () => toast('复制失败，请手动选择复制', true),
    );
  $('#ac-out', mask).onclick = () => {
    if (!confirm('退出后可用邮箱密码或已保存的恢复码登录。确定退出吗？')) return;
    mask.remove();
    logout();
  };
}

// ======================= 首页 =======================
function topbar() {
  return `<header class="topbar landing-nav"><a class="logo" href="#/"><span class="logo-mark">◎</span>Atoms <small>DEMO</small></a><nav aria-label="首页导航"><a href="#how-it-works" data-scroll="how-it-works">如何工作</a><a href="#inspiration" data-scroll="inspiration">设计灵感</a><a href="#team" data-scroll="team">AI 团队</a></nav><div class="nav-actions">${state.user ? `<button class="btn ghost" id="guide-btn">使用引导</button><button class="btn ghost user-chip" id="account-btn">${userAvatar(state.user.name)}<span>${esc(state.user.name)}</span></button>` : '<button class="btn ghost sm" id="login-btn">登录</button><button class="btn primary sm" id="signup-btn">免费开始 ↗</button>'}</div></header>`;
}

function raceControls(compact = false) {
  const on = state.race.on;
  const chosen = raceModels();
  const chips =
    !state.config.mockOnly && on
      ? `<div class="model-chips">${state.config.models.map((m) => `<button type="button" class="model-chip${chosen.includes(m) ? ' on' : ''}" data-model="${esc(m)}">${esc(m)}</button>`).join('')}</div>`
      : '';
  return `<button type="button" class="race-toggle${on ? ' on' : ''}" data-race-toggle title="同一需求交给多个模型同时生成，自动校验打分后择优采用">
      <span class="switch"></span>${ICONS.race} 赛马模式${on ? ` · ${chosen.length} 路` : ''}</button>${compact ? '' : chips}`;
}

function bindRaceControls(root, rerender) {
  root.querySelectorAll('[data-race-toggle]').forEach(
    (b) =>
      (b.onclick = () => {
        state.race.on = !state.race.on;
        store.set('atoms.race', state.race);
        rerender();
      }),
  );
  root.querySelectorAll('[data-model]').forEach(
    (b) =>
      (b.onclick = () => {
        const cur = raceModels();
        const m = b.dataset.model;
        let next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
        if (next.length === 0) return toast('至少保留一个模型', true);
        if (next.length > state.config.maxModels) return toast(`最多同时 ${state.config.maxModels} 路`, true);
        state.race.models = next;
        store.set('atoms.race', state.race);
        rerender();
      }),
  );
}

async function renderHome() {
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
  const drawOptions = (raceOpen = false) => {
    const slot = $('#race-slot');
    slot.innerHTML =
      optionsMarkup(options) + `<div class="race-settings ${raceOpen ? '' : 'hidden'}" data-advanced-race>${raceControls()}</div>`;
    bindComposerOptions(slot, options, {
      onChange: () => {
        saveComposerOptions(options);
        drawOptions();
      },
      onRace: () => slot.querySelector('[data-advanced-race]').classList.toggle('hidden'),
      notify: toast,
    });
    bindRaceControls(slot, () => drawOptions(true));
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

async function loadProjects() {
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

// ======================= 工作区 =======================
function closeWorkspace() {
  const ws = state.ws;
  if (!ws) return;
  ws.abort?.abort();
  ws.preview?.destroy();
  ws.closed = true;
  state.ws = null;
}

async function openWorkspace(id) {
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

async function reloadProject({ keepView = true } = {}) {
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

function viewIsValid(v) {
  const d = state.ws.data;
  if (v.type === 'version') return d.versions.some((x) => x.id === v.id);
  if (v.type === 'race') return d.races.some((x) => x.id === v.id);
  if (v.type === 'entry') return d.races.some((r) => r.entries.some((e) => e.id === v.id));
  return v.type === 'empty';
}

function defaultView() {
  const d = state.ws.data;
  const last = d.races[d.races.length - 1];
  if (last && (last.status === 'running' || last.status === 'review')) return { type: 'race', id: last.id };
  if (d.project.current_version_id) return { type: 'version', id: d.project.current_version_id };
  if (last) return { type: 'race', id: last.id };
  return { type: 'empty' };
}

function setView(view) {
  state.ws.view = view;
  state.ws.tab = 'preview';
  renderWorkspace();
}

const findEntry = (id) => {
  for (const r of state.ws.data.races) {
    const e = r.entries.find((x) => x.id === id);
    if (e) return { race: r, entry: e };
  }
  return null;
};

function renderWorkspace() {
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
function renderChat() {
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

function renderMessage(m) {
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

function renderComposer() {
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
function subscribe(jobId) {
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

function handleEvent(ev) {
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

function updateWorking() {
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

// ---------- 预览区 ----------
function renderViewer(force = false) {
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

async function renderPreview(box) {
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
      <span class="label">${label}</span><span class="spacer"></span>
      ${
        v.type === 'version' && v.id === d.project.current_version_id
          ? `<button class="btn sm ghost" id="vt-fix" hidden>${ICONS.wrench}<span>修复报错</span></button>
      <button class="icon-btn${ws.picking ? ' on' : ''}" id="vt-pick" title="选择元素后，用对话只修改它">${ICONS.pick}</button>`
          : ''
      }
      ${
        v.type === 'version'
          ? `<button class="icon-btn" id="vt-reset" title="清空这个应用保存的数据">${ICONS.eraser}</button>
      <button class="icon-btn" id="vt-open" title="在新标签页打开">${ICONS.open}</button>`
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
  $('#vt-console').onclick = () => {
    ws.consoleOpen = !ws.consoleOpen;
    $('#console').classList.toggle('hidden', !ws.consoleOpen);
    $('#vt-console').classList.toggle('on', ws.consoleOpen);
    renderConsole();
  };
  $('#vt-open') &&
    ($('#vt-open').onclick = () =>
      window.open(`/preview?project=${encodeURIComponent(ws.id)}&version=${encodeURIComponent(v.id)}`, '_blank'));
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
  ws.consoleLines = [];
  ws.picking = false;
  renderConsole();
  const preview = await mountPreview($('#frame-wrap'), html, {
    kv,
    onConsole: pushConsole,
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
}

function pushConsole(line) {
  const ws = state.ws;
  if (!ws) return;
  ws.consoleLines.push({ ...line, at: Date.now() });
  if (ws.consoleLines.length > 300) ws.consoleLines.shift();
  updateFixButton();
  if (line.level === 'error' && !ws.consoleOpen) {
    const btn = $('#vt-console');
    const n = ws.consoleLines.filter((l) => l.level === 'error').length;
    if (btn) btn.innerHTML = `${ICONS.console}<sup style="color:var(--err);font-weight:700">${n}</sup>`;
  }
  renderConsole();
}
function updateFixButton() {
  const ws = state.ws;
  const btn = $('#vt-fix');
  if (!btn || !ws) return;
  const n = ws.consoleLines.filter((l) => l.level === 'error').length;
  btn.hidden = !n || !!ws.jobId;
  btn.querySelector('span').textContent = `让 Alex 修复 ${n} 个报错`;
}

// 一键修复（对应 Atoms 的 Resolve）：把预览控制台的报错交给 Alex
async function fixErrors() {
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
    toast('已交给 Alex 修复');
  } catch (e) {
    toast(e.message, true);
  }
}

function renderConsole() {
  const el = $('#console');
  if (!el || el.classList.contains('hidden')) return;
  const lines = state.ws.consoleLines;
  el.innerHTML = lines.length
    ? lines.map((l) => `<div class="line ${esc(l.level)}">[${esc(l.level)}] ${esc(l.text)}</div>`).join('')
    : '<div class="line">暂无输出。应用里的 console 输出和报错会显示在这里。</div>';
  el.scrollTop = el.scrollHeight;
}

// ---------- 赛马对比 ----------
function renderRace(box) {
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
      ? `推荐采用 <b>${esc(modelLabel(race.entries.find((e) => e.id === best).model))}</b>（${scores[best].score} 分）。也可以先全屏试用再决定。`
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
  $('#rescore') &&
    ($('#rescore').onclick = () => {
      for (const e of done) delete scores[e.id];
      scheduleScoring(true);
      renderViewer(true);
    });
  // 已完成的候选挂一个缩小的可交互缩略预览
  for (const e of done) mountThumb(e.id);
}

function entryCard(race, e, best) {
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

function waitingText(entryId) {
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

function reviewHtml(review) {
  if (!review?.results?.length) return review?.summary ? `<div class="review-note">${esc(review.summary)}</div>` : '';
  const miss = review.results.filter((r) => !r.ok);
  return `<details class="review"><summary>Mike 验收：${review.results.length - miss.length}/${review.results.length} 项满足${miss.length ? `，<span style="color:var(--err)">${miss.length} 项未满足</span>` : ' ✓'}</summary>
    <ul>${review.results.map((r) => `<li class="${r.ok ? 'ok' : 'miss'}">${r.ok ? '✓' : '✗'} ${esc(r.feature)}${r.note ? `<span>${esc(r.note)}</span>` : ''}</li>`).join('')}</ul>
    ${review.summary ? `<div class="review-note">${esc(review.summary)}</div>` : ''}</details>`;
}

function patchEntry(ev) {
  const s = document.querySelector(`[data-stream="${ev.entryId}"]`);
  if (s) s.textContent = ev.tail || waitingText(ev.entryId);
  const c = document.querySelector(`[data-chars="${ev.entryId}"]`);
  if (c) c.textContent = `📝 ${fmtChars(ev.chars)} 字`;
}

const thumbCache = new Map();
async function mountThumb(entryId) {
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
let scoringQueue = Promise.resolve();
function scheduleScoring(force = false) {
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
}

async function scoreEntry(ws, e) {
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
    }).catch(() => {});
  } finally {
    ws.scoring.delete(e.id);
    if (!ws.closed && state.ws === ws) {
      if (ws.view?.type === 'race') renderViewer(true);
      if (ws.scoring.size === 0) renderChat();
    }
  }
}

// ---------- 动作 ----------
async function adopt(entryId) {
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

async function restoreVersion(versionId) {
  try {
    const r = await api(`/api/versions/${versionId}/restore`, { method: 'POST' });
    toast(`已回退，生成 Version ${r.version.seq}`);
    await reloadProject({ keepView: false });
    setView({ type: 'version', id: r.version.id });
  } catch (e) {
    toast(e.message, true);
  }
}

async function remixVersion(versionId) {
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

async function renameProject() {
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

async function downloadCurrent() {
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

async function publish() {
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

function renderDrawer() {
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

// ======================= 路由 =======================
async function render() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/p\/([\w-]+)/);
  if (m) {
    if (!state.user) {
      location.hash = '#/';
      return;
    }
    return openWorkspace(m[1]);
  }
  return renderHome();
}

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch {
    /* 保持默认演示配置 */
  }
  if (state.token) {
    try {
      state.user = (await api('/api/me')).user;
    } catch {
      /* token 失效会在 api() 里清掉 */
    }
  }
  window.addEventListener('hashchange', render);
  await render();
  // 首页先展示，再由用户主动登录；不以不可关闭弹窗遮住首屏。
}

boot();
