// 入口：路由与启动
import { api, state } from './core.js';
import { renderHome } from './home.js';
import { openWorkspace } from './workspace.js';

// ======================= 路由 =======================
export async function render() {
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
