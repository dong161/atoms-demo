// 账号：Google / 邮箱登录注册、首次引导、头像下拉菜单与账号设置
import { render } from './app.js';
import { $, AGENTS, EXAMPLES, api, esc, state, store, toast, userAvatar } from './core.js';
import { agentAvatars } from './landing.js';

// ======================= 账号 =======================
export function logout(expired = false) {
  // 主动退出时让服务端吊销本次会话；令牌已失效时不必再请求
  if (!expired && state.token)
    fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${state.token}` } }).catch(() => {});
  state.token = null;
  state.user = null;
  store.del('atoms.token');
  if (expired) toast('登录已失效，请重新进入', true);
  location.hash = '#/';
  render();
}

export function accessibleDialog(mask, close) {
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
export function showOnboarding({ afterLogin, mode = 'register' } = {}) {
  if (mode !== 'login') mode = 'register';
  if (document.querySelector('.auth-mask')) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask auth-mask';
  let remove,
    busy = false;
  const close = () => {
    if (!busy) remove();
  };
  // 登录成功后的统一收尾：保存会话、刷新界面，新用户且没有待提交需求时展示新手引导
  const finishLogin = async (r, isNew) => {
    state.token = r.token;
    state.user = r.user;
    store.set('atoms.token', r.token);
    busy = false;
    remove();
    await render();
    toast(`欢迎${isNew ? '' : '回来'}，${r.user.name}`);
    // 已经写好需求再登录的用户，直接提交需求，不再插入新手引导
    if (isNew && !afterLogin) showFirstRun();
    else {
      if (afterLogin) store.set(`atoms.onboarded.${r.user.id}`, true);
      afterLogin?.();
    }
  };
  const googleLogin = async (credential) => {
    if (busy) return;
    busy = true;
    $('#auth-error', mask).textContent = '';
    try {
      const r = await api('/api/auth/google', { method: 'POST', body: { credential } });
      await finishLogin(r, r.created);
    } catch (err) {
      busy = false;
      $('#auth-error', mask).textContent = `Google 登录失败：${err.message}`;
    }
  };
  const draw = () => {
    mask.innerHTML = `<div class="auth-shell" role="dialog" aria-modal="true" aria-labelledby="auth-title"><aside class="auth-art"><div class="auth-brand">◎ Atoms <small>DEMO</small></div><div class="auth-orbit">${['mike', 'emma', 'alex'].map((k) => `<img src="${agentAvatars[k]}" alt="${AGENTS[k].name}">`).join('')}</div><h2>一个想法，<br>一整个 AI 团队。</h2><p>从第一句话，到第一个能点击的产品。你的创作之旅，从这里开始。</p><small>独立演示项目 · 非 Atoms 官方账号</small></aside><section class="auth-content"><button class="icon-btn auth-close" id="auth-close" aria-label="关闭登录窗口">✕</button><div class="auth-tabs"><button type="button" data-auth-mode="login" class="${mode === 'login' ? 'active' : ''}">登录</button><button type="button" data-auth-mode="register" class="${mode === 'register' ? 'active' : ''}">注册</button></div><h2 id="auth-title">${mode === 'login' ? '欢迎回来' : '开启你的创作之旅'}</h2><p>${mode === 'login' ? '登录后，继续你的项目和创作。' : '创建账号，你的项目会保存在云端，换设备也能继续。'}</p>${state.config.googleClientId ? '<div class="google-login"><div id="google-btn" aria-label="使用 Google 账号登录"></div><div class="auth-divider"><span>或使用邮箱</span></div></div>' : ''}<form id="auth-form">${mode === 'register' ? '<label for="auth-name">昵称</label><input class="field" id="auth-name" name="nickname" autocomplete="nickname" maxlength="30" required placeholder="怎么称呼你？">' : ''}${`<label for="auth-email">邮箱</label><input class="field" id="auth-email" type="email" maxlength="254" autocomplete="email" required placeholder="you@example.com"><label for="auth-password">密码</label><div class="password-field"><input class="field" id="auth-password" type="password" minlength="10" maxlength="128" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required placeholder="至少 10 个字符"><button type="button" id="password-eye" aria-label="显示密码">显示</button></div>`}<div class="auth-error" id="auth-error" role="alert"></div><button class="btn primary auth-submit" type="submit">${mode === 'login' ? '登录并继续' : '创建账号'} ↗</button></form><p class="auth-switch">${mode === 'login' ? '还没有账号？<button class="link" data-auth-mode="register">免费注册</button>' : '已有账号？<button class="link" data-auth-mode="login">直接登录</button>'}</p><p class="auth-disclaimer">暂不支持通过邮件找回密码，推荐使用 Google 登录。</p></section></div>`;
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
        const r = await api(`/api/auth/${mode}`, {
          method: 'POST',
          body: {
            email: $('#auth-email', mask).value.trim(),
            password: pw.value,
            ...(mode === 'register' ? { name: $('#auth-name', mask).value.trim() } : {}),
          },
        });
        await finishLogin(r, mode === 'register');
      } catch (err) {
        state.token = oldToken;
        $('#auth-error', mask).textContent = err.status === 401 ? '邮箱或密码不正确' : err.message;
        busy = false;
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    const gbox = $('#google-btn', mask);
    if (gbox) renderGoogleButton(gbox, mode, googleLogin, (msg) => ($('#auth-error', mask).textContent = msg));
    const first = mask.querySelector('input');
    first?.focus();
  };
  document.body.appendChild(mask);
  remove = accessibleDialog(mask, close);
  draw();
}
export function showFirstRun({ afterDone } = {}) {
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

// ---------- 头像下拉菜单 ----------
export function userMenu() {
  const u = state.user;
  return `<div class="user-menu"><button class="btn ghost user-chip" id="account-btn" aria-haspopup="menu" aria-expanded="false">${userAvatar(u.name)}<span>${esc(u.name)}</span><i class="caret">⌄</i></button><div class="menu hidden" role="menu" id="account-menu"><div class="menu-head">${userAvatar(u.name)}<div><b>${esc(u.name)}</b><small>${u.email ? esc(u.email) : '未设置登录方式'}</small></div></div><button role="menuitem" data-menu="projects"><i>▦</i><span>我的项目</span></button><button role="menuitem" data-menu="settings"><i>⚙</i><span>账号设置</span>${hasLogin(u) ? '' : '<em class="dot" title="需要设置登录方式"></em>'}</button><button role="menuitem" data-menu="guide"><i>✦</i><span>使用引导</span></button><hr><button role="menuitem" data-menu="logout" class="danger"><i>⏻</i><span>退出登录</span></button></div></div>`;
}

const hasLogin = (u) => !!(u?.email || u?.google);

export function bindUserMenu(root = document) {
  const btn = $('#account-btn', root);
  const menu = $('#account-menu', root);
  if (!btn || !menu) return;
  const set = (open) => {
    menu.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      menu.querySelector('[role=menuitem]')?.focus();
      setTimeout(() => document.addEventListener('pointerdown', outside));
    } else document.removeEventListener('pointerdown', outside);
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) set(false);
  };
  btn.onclick = () => set(menu.classList.contains('hidden'));
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll('[role=menuitem]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      set(false);
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  };
  menu.querySelectorAll('[data-menu]').forEach(
    (b) =>
      (b.onclick = () => {
        set(false);
        const act = b.dataset.menu;
        if (act === 'projects') goProjects();
        else if (act === 'settings') showSettings();
        else if (act === 'guide') showFirstRun();
        else if (act === 'logout') confirmLogout();
      }),
  );
}

function goProjects() {
  const scroll = () => document.getElementById('projects-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (location.hash && location.hash !== '#/') {
    location.hash = '#/';
    setTimeout(scroll, 300);
  } else scroll();
}

function confirmLogout() {
  if (!hasLogin(state.user)) {
    // 早期快速体验创建的账号没有登录方式：退出前先引导设置，否则退出后无法再登录
    if (confirm('你的账号还没有设置登录方式，退出后将无法再次登录。现在去设置吗？')) return showSettings();
    if (!confirm('确定不设置，直接退出吗？')) return;
  }
  logout();
  toast('已退出登录');
}

// ---------- 账号设置 ----------
export function showSettings() {
  const u = state.user;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const method = u.google ? `Google 账号${u.email ? ` · ${esc(u.email)}` : ''}` : u.email ? `邮箱密码 · ${esc(u.email)}` : '';
  mask.innerHTML = `
    <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="st-title">
      <h2 id="st-title">账号设置</h2>
      <section class="settings-sec">
        <h3>个人资料</h3>
        <form id="st-name-form" class="settings-row">
          ${userAvatar(u.name)}
          <input class="field" id="st-name" maxlength="30" required value="${esc(u.name)}" aria-label="昵称">
          <button class="btn" type="submit">保存</button>
        </form>
      </section>
      <section class="settings-sec">
        <h3>登录方式</h3>
        ${
          method
            ? `<p class="settings-ok">✓ ${method}<br><small>退出后用它重新登录，项目都保存在云端。</small></p>`
            : `<p class="settings-warn">还没有设置登录方式。设置后可以在任何设备登录，并找回你的项目。</p>
        ${state.config.googleClientId ? '<div id="bind-google"></div><div class="auth-divider"><span>或使用邮箱</span></div>' : ''}
        <form id="bind-form" class="bind-form">
          <input class="field" id="bind-email" type="email" maxlength="254" autocomplete="email" required placeholder="邮箱">
          <input class="field" id="bind-password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required placeholder="设置密码（至少 10 个字符）">
          <button class="btn primary" type="submit">设置邮箱登录</button>
        </form>`
        }
        <div class="auth-error" id="st-error" role="alert"></div>
      </section>
      <div class="row"><button class="btn primary" id="st-close">完成</button></div>
    </div>`;
  document.body.appendChild(mask);
  let remove;
  const close = () => remove();
  remove = accessibleDialog(mask, close);
  $('#st-close', mask).onclick = close;
  const err = (m) => ($('#st-error', mask).textContent = m);
  const updated = async (user, msg) => {
    state.user = user;
    close();
    await render();
    toast(msg);
  };
  $('#st-name-form', mask).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/me', { method: 'PATCH', body: { name: $('#st-name', mask).value.trim() } });
      updated(r.user, '昵称已更新');
    } catch (e2) {
      err(e2.message);
    }
  };
  if (!method) {
    $('#bind-form', mask).onsubmit = async (e) => {
      e.preventDefault();
      err('');
      try {
        const r = await api('/api/auth/bind-email', {
          method: 'POST',
          body: { email: $('#bind-email', mask).value.trim(), password: $('#bind-password', mask).value },
        });
        updated(r.user, '已设置邮箱登录');
      } catch (e2) {
        err(e2.message);
      }
    };
    const gbox = $('#bind-google', mask);
    if (gbox)
      renderGoogleButton(
        gbox,
        'bind',
        async (credential) => {
          err('');
          try {
            const r = await api('/api/auth/bind-google', { method: 'POST', body: { credential } });
            updated(r.user, '已关联 Google 账号');
          } catch (e2) {
            err(e2.message);
          }
        },
        err,
      );
  }
}

// ---------- Google 登录按钮（Google Identity Services） ----------
let gisLoading = null;
function loadGis() {
  gisLoading ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true;
    sc.onload = () => resolve(window.google);
    sc.onerror = () => {
      gisLoading = null;
      reject(new Error('无法连接 Google，请检查网络或改用邮箱登录'));
    };
    document.head.appendChild(sc);
  });
  return gisLoading;
}

async function renderGoogleButton(el, mode, onCredential, onError) {
  try {
    const google = await loadGis();
    google.accounts.id.initialize({
      client_id: state.config.googleClientId,
      callback: (resp) => onCredential(resp.credential),
      ux_mode: 'popup',
      context: mode === 'login' ? 'signin' : mode === 'bind' ? 'use' : 'signup',
    });
    google.accounts.id.renderButton(el, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: mode === 'login' ? 'signin_with' : mode === 'bind' ? 'continue_with' : 'signup_with',
      locale: 'zh_CN',
      width: Math.min(el.clientWidth || 360, 400),
    });
  } catch (e) {
    onError(e.message);
  }
}
