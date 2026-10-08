import { applyTheme, themeInstruction } from './generation-options.js';
// 智能体：Mike（组长，拆需求出方案）、Alex（工程师，写/改代码）。
// 每个智能体都有 mock 实现：没配模型或模型失败时自动兜底，保证流程能走完。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamChatWithRetry } from './llm.js';
import { extractHtml } from './html.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------- Mike：需求拆解 ----------------

const PLANNER_SYSTEM = `你是 Atoms 团队的组长 Mike。用户会用一句话描述想要的网页应用。
把它拆成给工程师的简明开发说明，只输出 JSON，不要任何其它文字：
{"title":"应用名（≤12字）","summary":"一句话说明这个应用做什么","features":["核心功能1","核心功能2","..."],"design":"视觉风格与配色建议","data":"需要持久化保存哪些数据"}
features 3-6 条，每条具体可验证。用和用户相同的语言回答。`;

export async function planProject({ cfg, prompt, signal, onDelta }) {
  if (cfg.mockOnly) return { ...mockPlan(prompt), source: 'mock' };
  try {
    const raw = await streamChatWithRetry({
      cfg, model: cfg.plannerModel, signal, temperature: 0.4, maxTokens: 1200, onDelta,
      messages: [{ role: 'system', content: PLANNER_SYSTEM }, { role: 'user', content: prompt }],
    });
    const plan = parsePlan(raw);
    if (plan) return { ...plan, source: cfg.plannerModel };
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  return { ...mockPlan(prompt), source: 'mock' };
}

export function parsePlan(raw) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!j.title || !Array.isArray(j.features)) return null;
    return {
      title: String(j.title).slice(0, 40),
      summary: String(j.summary || ''),
      features: j.features.map(String).slice(0, 8),
      design: String(j.design || ''),
      data: String(j.data || ''),
    };
  } catch {
    return null;
  }
}

export function mockPlan(prompt) {
  const t = pickTemplate(prompt);
  return { ...t.plan, summary: `根据「${prompt.slice(0, 40)}」生成：${t.plan.summary}` };
}

// ---------------- Alex：写代码 / 改代码 ----------------

const ENGINEER_RULES = `硬性要求：
1. 只输出一个完整的单文件 HTML（<!DOCTYPE html> 开头，</html> 结尾），CSS 和 JS 全部内联，不要输出任何解释或 markdown 围栏。
2. 不引用任何外部资源（CDN、字体、图片 URL、接口都不行），图标用内联 SVG 或 emoji。
3. 必须有真实交互，所有按钮都要能用。
4. 用户数据用 localStorage 持久化（平台会把它同步到云端），刷新后数据要还在。饮水量、专注时长、计数、金额等真实业务统计首次打开必须从 0 或空记录开始，不得伪造用户已完成的记录。示例数据仅在适合的列表或展示应用中使用，并明确标为演示；编辑已有应用时不得重置或污染已保存的用户数据。
5. 必须适配手机（含 viewport meta，375px 宽不出现横向滚动）。
6. 界面语言与用户需求的语言一致；设计现代、留白充足、配色统一，主色写成 CSS 变量 --primary。
7. 代码精炼，总长度控制在 600 行以内。`;

function createMessages(plan, prompt) {
  return [
    { role: 'system', content: `你是 Atoms 团队的工程师 Alex，擅长把需求做成能直接运行的网页应用。\n${ENGINEER_RULES}` },
    {
      role: 'user',
      content: `用户原始需求：${prompt}\n\n组长 Mike 的开发说明：\n应用名：${plan.title}\n概述：${plan.summary}\n功能：\n${plan.features.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n设计：${plan.design}\n数据：${plan.data}\n\n现在输出完整 HTML。`,
    },
  ];
}

function editMessages(baseHtml, instruction) {
  return [
    { role: 'system', content: `你是 Atoms 团队的工程师 Alex。用户会给你一个现有的单文件网页应用和修改要求。在原有基础上修改，保留没要求改动的功能、数据结构和 localStorage 键名。\n${ENGINEER_RULES}` },
    { role: 'user', content: `现有代码：\n${baseHtml}\n\n修改要求：${instruction}\n\n输出修改后的完整 HTML。` },
  ];
}

/**
 * 生成一个候选结果。mode=create 用 plan 从零写；mode=edit 在 baseHtml 上改。
 * 返回 { html, source }，source 为实际使用的模型名或 'mock'。
 */
export async function engineerBuild({ cfg, model, mode, plan, prompt, baseHtml, instruction, variant = 0, signal, onDelta, onRetry, onReset, themeId = 'default' }) {
  if (cfg.mockOnly || model === 'mock') {
    const html = mode === 'edit' ? mockEdit(baseHtml, instruction) : mockCreate(prompt, plan, variant);
    await fakeStream(html, onDelta, signal);
    return { html:applyTheme(html,themeId), source: 'mock' };
  }
  const messages = mode === 'edit' ? editMessages(baseHtml, instruction) : createMessages(plan, prompt);
  messages[0].content += themeInstruction(themeId);
  const needScript = mode !== 'edit' || /<script[\s>]/i.test(baseHtml || '');
  let lastProblem = '';
  // 输出被截断/不完整时整段重来一次（最多 2 次尝试）
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) { onRetry?.(new Error(lastProblem), attempt - 1); onReset?.(); }
    const raw = await streamChatWithRetry({
      cfg, model, messages, signal, onDelta, onRetry, onReset,
      temperature: 0.6 + (variant % 3) * 0.1,
      maxTokens: 24000,
    });
    const html = extractHtml(raw);
    lastProblem = htmlProblem(html, needScript);
    if (!lastProblem) return { html:applyTheme(html,themeId), source: model };
    if (signal?.aborted) break;
  }
  throw new Error(`生成结果不完整：${lastProblem}`);
}

/** 判断生成的 HTML 是否是一个完整可运行的文档，返回问题描述或空字符串。 */
export function htmlProblem(html, needScript = true) {
  if (!/<html[\s>]/i.test(html)) return '没有输出有效的 HTML';
  if (!/<\/html>\s*$/i.test(html)) return '输出被截断（缺少 </html>）';
  if (needScript && !/<script[\s>]/i.test(html)) return '缺少脚本，应用无法交互';
  return '';
}

// ---------------- Mike：对照需求验收 ----------------

const REVIEW_SYSTEM = `你是 Atoms 团队的组长 Mike，负责验收工程师交付的单文件网页应用。
逐条检查需求清单里的每一项是否在代码中真正实现（有对应的界面和可用的交互逻辑，而不只是文字描述）。
涉及累计数值或用户记录时，还要核查空存储的初始值是否为零或空；伪造的示例记录不能冒充用户真实数据。
只输出 JSON，不要其它文字：
{"results":[{"ok":true,"note":"≤20字的依据"}],"summary":"≤40字的总体评价"}
results 的顺序和数量必须与需求清单完全一致。用中文回答。`;

/** 需求清单：首轮用 Mike 的功能列表；修改时把本次修改要求放在第一条。 */
export function reviewChecklist({ mode, plan, instruction }) {
  const base = plan?.features?.length ? plan.features : [];
  return mode === 'edit' ? [`本次修改：${instruction}`, ...base].slice(0, 8) : base.slice(0, 8);
}

export async function reviewBuild({ cfg, html, checklist, signal }) {
  if (!checklist.length) return null;
  if (cfg.mockOnly) {
    return { source: 'mock', summary: '演示模式：未调用模型验收，默认视为全部满足', results: checklist.map((f) => ({ feature: f, ok: true, note: '演示模式' })) };
  }
  try {
    const raw = await streamChatWithRetry({
      cfg, model: cfg.plannerModel, signal, temperature: 0.1, maxTokens: 1500,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        { role: 'user', content: `需求清单：\n${checklist.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n代码：\n${html.slice(0, 60000)}` },
      ],
    });
    return parseReview(raw, checklist, cfg.plannerModel);
  } catch (e) {
    if (signal?.aborted) throw e;
    return { source: 'error', summary: `验收失败：${e.message}`, results: null };
  }
}

export function parseReview(raw, checklist, source) {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return { source: 'error', summary: '验收结果无法解析', results: null };
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.results)) throw new Error('缺少 results');
    const results = checklist.map((f, i) => ({ feature: f, ok: !!j.results[i]?.ok, note: String(j.results[i]?.note ?? '').slice(0, 60) }));
    return { source, summary: String(j.summary || '').slice(0, 120), results };
  } catch {
    return { source: 'error', summary: '验收结果无法解析', results: null };
  }
}

// ---------------- mock 实现 ----------------

const TEMPLATES = [
  {
    file: 'kanban.html',
    match: /看板|kanban|待办|todo|任务|项目管理|清单|task/i,
    plan: {
      title: '项目看板',
      summary: '带优先级、截止日期和拖拽排序的任务看板',
      features: ['新建任务（标题、优先级、截止日期）', '待办 / 进行中 / 已完成 三列', '拖拽卡片在列之间移动', '按优先级着色、逾期高亮', '数据自动保存'],
      design: '浅色背景，紫色主色，圆角卡片',
      data: '任务列表（标题、优先级、截止日、所在列）',
    },
  },
  {
    file: 'homepage.html',
    match: /主页|个人|简历|portfolio|作品集|名片|介绍|resume|landing/i,
    plan: {
      title: '个人主页',
      summary: '可在线编辑的个人主页，包含简介、技能、项目和联系方式',
      features: ['头像、姓名、职业简介展示', '技能标签可增删', '项目经历卡片', '一键切换编辑模式直接改文字', '编辑内容自动保存'],
      design: '深色头图 + 浅色内容区，蓝色主色',
      data: '个人资料、技能列表、项目列表',
    },
  },
  {
    file: 'calculator.html',
    match: /计算|房贷|贷款|月供|calculator|利息|理财|工具/i,
    plan: {
      title: '房贷计算器',
      summary: '等额本息 / 等额本金月供计算，支持提前还款对比',
      features: ['输入贷款总额、年限、利率', '等额本息与等额本金切换', '提前还款节省利息对比', '还款计划表', '保存最近计算记录'],
      design: '卡片式表单，绿色主色，数字醒目',
      data: '最近 10 次计算参数与结果',
    },
  },
];

const PALETTES = ['#6d5efc', '#0ea5e9', '#10b981', '#f97316', '#e11d48'];

export function pickTemplate(prompt) {
  return TEMPLATES.find((t) => t.match.test(prompt)) ?? TEMPLATES[0];
}

export function mockCreate(prompt, plan, variant = 0) {
  const t = pickTemplate(prompt);
  let html = fs.readFileSync(path.join(here, 'mock', t.file), 'utf8');
  const title = plan?.title || t.plan.title;
  html = html.replaceAll('{{TITLE}}', escapeHtml(title));
  return setPrimary(html, PALETTES[variant % PALETTES.length]);
}

const COLOR_WORDS = [
  [/蓝|blue/i, '#2563eb'], [/绿|green/i, '#16a34a'], [/红|red/i, '#dc2626'],
  [/橙|orange/i, '#ea580c'], [/紫|purple/i, '#7c3aed'], [/粉|pink/i, '#db2777'], [/黑|black|暗/i, '#111827'],
];

export function mockEdit(baseHtml, instruction = '') {
  const hit = COLOR_WORDS.find(([re]) => re.test(instruction));
  let html = hit ? setPrimary(baseHtml, hit[1]) : baseHtml;
  if (/暗色|深色|dark/i.test(instruction)) {
    html = html.replace('</head>', '<style>body{background:#0f172a!important;color:#e2e8f0!important}</style>\n</head>');
  }
  const note = `<!-- mock edit: ${instruction.replace(/--/g, '').slice(0, 80)} -->`;
  return html.replace(/<\/html>\s*$/i, `${note}\n</html>`);
}

function setPrimary(html, color) {
  return html.replace(/--primary:\s*#[0-9a-fA-F]{3,8}/, `--primary: ${color}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fakeStream(text, onDelta, signal) {
  const chunks = 24;
  const size = Math.ceil(text.length / chunks);
  for (let i = 0; i < text.length; i += size) {
    if (signal?.aborted) throw new Error('已取消');
    onDelta?.(text.slice(i, i + size));
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 80));
  }
}
