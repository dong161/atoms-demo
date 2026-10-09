// 账号：注册 / 登录 / 恢复码、首次引导、账号菜单
import { render } from './app.js';
import { $, AGENTS, EXAMPLES, api, esc, state, store, toast } from './core.js';
import { agentAvatars } from './landing.js';

// ======================= 账号（注册 / 恢复码） =======================
export function logout(expired = false) {
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
        // 已经写好需求再登录的用户，直接提交需求，不再插入新手引导；空手注册的新用户才展示三步引导
        if ((mode === 'guest' || mode === 'register') && !afterLogin) showFirstRun();
        else {
          if (afterLogin) store.set(`atoms.onboarded.${r.user.id}`, true);
          afterLogin?.();
        }
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

export function showAccount() {
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
