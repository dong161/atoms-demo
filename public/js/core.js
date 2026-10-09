// 基础工具、全局状态与 API 请求
import { logout } from './auth.js';

// ======================= 基础工具 =======================
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const store = {
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

export const AGENTS = {
  mike: { name: 'Mike', role: '组长', color: '#6d5efc', initial: 'M' },
  alex: { name: 'Alex', role: '工程师', color: '#0ea5e9', initial: 'A' },
  emma: { name: 'Emma', role: '产品经理', color: '#f97316', initial: 'E' },
  bob: { name: 'Bob', role: '架构师', color: '#10b981', initial: 'B' },
  david: { name: 'David', role: '数据分析', color: '#e11d48', initial: 'D' },
  system: { name: '系统', role: '', color: '#9aa0b5', initial: 'S' },
};

export const EXAMPLES = [
  { label: '📋 项目看板', text: '做一个项目看板：任务有优先级和截止日期，可以在待办/进行中/已完成之间拖拽，逾期任务高亮' },
  { label: '🏠 房贷计算器', text: '做一个房贷计算器，支持等额本息和等额本金，能对比提前还款能省多少利息，并保存最近的计算记录' },
  { label: '👤 个人主页', text: '做一个可在线编辑的个人主页：头像、简介、技能标签、项目经历和联系方式，编辑后自动保存' },
  { label: '💧 喝水打卡', text: '做一个每日喝水打卡应用，可以设置每日目标，点击记录一杯水，显示本周完成情况的柱状图' },
];

export let toastTimer;
export function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), err ? 4000 : 2200);
}

export const fmtTime = (t) => {
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
export const fmtChars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
export const modelLabel = (m) => (m === 'mock' ? '演示模型' : m);

export function avatar(key, size) {
  const a = AGENTS[key] || AGENTS.system;
  const style = `background:${a.color}${size ? `;width:${size}px;height:${size}px` : ''}`;
  return `<span class="avatar" style="${style}" title="${esc(a.name)}${a.role ? ' · ' + esc(a.role) : ''}">${a.initial}</span>`;
}
export function userAvatar(name) {
  const colors = ['#6d5efc', '#0ea5e9', '#10b981', '#f97316', '#e11d48', '#8b5cf6'];
  const c = colors[[...(name || '?')].reduce((s, ch) => s + ch.charCodeAt(0), 0) % colors.length];
  return `<span class="avatar" style="background:${c}">${esc([...(name || '?')][0].toUpperCase())}</span>`;
}

export const ICONS = {
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
export const state = {
  token: store.get('atoms.token'),
  user: null,
  config: { mockOnly: true, models: ['mock'], defaultRace: ['mock', 'mock'], maxModels: 3 },
  race: store.get('atoms.race', { on: true, models: null }),
  ws: null,
};

export async function api(path, { method = 'GET', body } = {}) {
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

// 赛马阵容由服务端按模型健康度自动挑选（最近成功率高、速度快的优先），界面只提供开关
export function raceModels() {
  const list = state.config.defaultRace?.length ? state.config.defaultRace : state.config.models;
  return state.race.on ? list.slice(0, state.config.maxModels) : [list[0]];
}
