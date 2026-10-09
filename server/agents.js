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

const PLANNER_SYSTEM = `你是 Atoms 团队的组长 Mike（资深产品经理）。用户会用一句话描述想要的网页应用。
你要把它扩展成一个「正式上线也拿得出手」的产品方案，写成交给工程师的开发说明。只输出 JSON，不要任何其它文字：
{"title":"应用名（≤12字）","summary":"一句话说明这个应用帮谁解决什么问题","views":["视图1：包含什么","视图2：..."],"features":["功能1","功能2","..."],"design":"视觉风格：主色、氛围、布局方式、关键组件样式","data":"localStorage 中保存哪些数据（字段级）"}
要求：
- features 6-8 条，每条具体、可在页面上点一点就验证。覆盖：核心主流程（例如新建→处理→完成）、编辑与删除（删除要确认）、搜索/筛选/排序中合适的一项、统计或概览（数字、进度、分组汇总）、空状态引导（无数据时说明下一步并提供「载入示例数据」按钮）、以及 1-2 个让产品更好用的细节（快捷键、批量操作、导出/导入 JSON、撤销等，挑最适合的）。
- views 2-4 个：一个主工作区加上概览/统计、详情或设置等，用标签页或侧边导航切换；简单工具类可以只有 1-2 个。
- 技术边界（必须遵守，写进方案里也不能违背）：纯前端单文件 HTML；数据只用 localStorage；不要登录、后端、IndexedDB、第三方接口或外部资源。
- 用和用户相同的语言回答。`;

/** Mike 用哪个模型：首选 plannerModel，其余按健康度排序；最多尝试 3 个，前一个失败就换下一个 */
export function plannerCandidates(cfg, limit = 3) {
  const all = [...new Set([cfg.plannerModel, ...(cfg.models || [])].filter(Boolean))];
  return (cfg.health ? cfg.health.rank(all) : all).slice(0, limit);
}

async function withPlannerFallback(cfg, signal, run) {
  let lastError;
  for (const model of plannerCandidates(cfg)) {
    const started = Date.now();
    try {
      const out = await run(model);
      cfg.health?.record(model, { ok: true, ms: Date.now() - started });
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      cfg.health?.record(model, { ok: false, ms: Date.now() - started });
      lastError = e;
    }
  }
  throw lastError || new Error('没有可用的模型');
}

export async function planProject({ cfg, prompt, signal, onDelta }) {
  if (cfg.mockOnly) return { ...mockPlan(prompt), source: 'mock' };
  try {
    return await withPlannerFallback(cfg, signal, async (model) => {
      const raw = await streamChatWithRetry({
        cfg,
        model,
        signal,
        temperature: 0.4,
        maxTokens: 2000,
        onDelta,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM },
          { role: 'user', content: prompt },
        ],
      });
      const plan = parsePlan(raw);
      if (!plan) throw new Error('规划结果无法解析');
      return { ...plan, source: model };
    });
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
      views: Array.isArray(j.views) ? j.views.map(String).slice(0, 4) : [],
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
2. 不引用任何外部资源（CDN、字体、图片 URL、接口都不行，运行环境会拦截），图标用内联 SVG。
3. 必须有真实交互，每个按钮、表单、标签页都要真的能用；不要出现「敬请期待」「TODO」或点了没反应的控件。
4. 用户数据只用 localStorage 持久化（平台会把它同步到云端），刷新后数据和当前视图都要还在。读取时做好容错（数据损坏不白屏）。
5. 饮水量、专注时长、计数、金额、任务等真实业务数据首次打开必须从 0 或空记录开始，不得伪造用户已完成的记录；但空状态必须精心设计：插图（内联 SVG）+ 一句说明 + 主操作按钮 + 「载入示例数据」按钮（示例数据要像真实内容，载入后明确标为演示且可一键清除）。编辑已有应用时不得重置或污染已保存的用户数据。
6. 必须适配手机（含 viewport meta，375px 宽不出现横向滚动；窄屏时侧边导航收起成顶部标签）。
7. 界面语言与用户需求的语言一致。

产品质量标准（按上线产品的标准做，不是演示页）：
- 布局：有应用外壳（顶部栏含应用名与图标、主要操作；多视图用标签页或侧边导航），内容区有清晰的层级和留白，最大宽度合理居中。
- 视觉：主色写成 CSS 变量 --primary，并定义一组配套变量（背景、卡片、边框、文字、次要文字、成功/警告/危险色、圆角、阴影）。卡片有细边框和柔和阴影，按钮有主次之分，hover/active/focus 状态和 150-200ms 过渡完整；统计数字醒目；优先级、状态等用彩色标签区分。
- 交互：表单有校验和错误提示；新建/编辑用弹窗或抽屉（Esc 关闭、点击遮罩关闭）；删除二次确认；操作后用 toast 反馈；常用操作支持键盘（Enter 提交）。
- 内容：方案里的每个功能和视图都要实现，统计要根据真实数据实时计算。
- 代码：结构清晰（状态对象 + render 函数 + 事件委托），不要为了省篇幅砍功能；完整实现优先，通常 500-1200 行。
- 输出前自查运行错误：用到的每个函数、变量、元素 id 都已定义且一致；如果写了 $ 之类的简写，只返回单个元素，遍历多个元素一律用 document.querySelectorAll(...).forEach；事件绑定的元素在绑定时已存在。`;

function createMessages(plan, prompt) {
  return [
    { role: 'system', content: `你是 Atoms 团队的工程师 Alex，擅长把需求做成能直接运行的网页应用。\n${ENGINEER_RULES}` },
    {
      role: 'user',
      content: `用户原始需求：${prompt}\n\n组长 Mike 的开发说明：\n应用名：${plan.title}\n概述：${plan.summary}\n${plan.views?.length ? `视图：\n${plan.views.map((v, i) => `${i + 1}. ${v}`).join('\n')}\n` : ''}功能：\n${plan.features.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n设计：${plan.design}\n数据：${plan.data}\n\n现在输出完整 HTML。`,
    },
  ];
}

function editMessages(baseHtml, instruction) {
  return [
    {
      role: 'system',
      content: `你是 Atoms 团队的工程师 Alex。用户会给你一个现有的单文件网页应用和修改要求。在原有基础上修改，保留没要求改动的功能、数据结构和 localStorage 键名。\n${ENGINEER_RULES}`,
    },
    { role: 'user', content: `现有代码：\n${baseHtml}\n\n修改要求：${instruction}\n\n输出修改后的完整 HTML。` },
  ];
}

/**
 * 生成一个候选结果。mode=create 用 plan 从零写；mode=edit 在 baseHtml 上改。
 * 返回 { html, source }，source 为实际使用的模型名或 'mock'。
 */
export async function engineerBuild({
  cfg,
  model,
  mode,
  plan,
  prompt,
  baseHtml,
  instruction,
  variant = 0,
  signal,
  onDelta,
  onRetry,
  onReset,
  themeId = 'default',
}) {
  if (cfg.mockOnly || model === 'mock') {
    const html = mode === 'edit' ? mockEdit(baseHtml, instruction) : mockCreate(prompt, plan, variant);
    await fakeStream(html, onDelta, signal);
    return { html: applyTheme(html, themeId), source: 'mock' };
  }
  const messages = mode === 'edit' ? editMessages(baseHtml, instruction) : createMessages(plan, prompt);
  messages[0].content += themeInstruction(themeId);
  const needScript = mode !== 'edit' || /<script[\s>]/i.test(baseHtml || '');
  let lastProblem = '';
  // 输出被截断/不完整时整段重来一次（最多 2 次尝试）
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      onRetry?.(new Error(lastProblem), attempt - 1);
      onReset?.();
    }
    const raw = await streamChatWithRetry({
      cfg,
      model,
      messages,
      signal,
      onDelta,
      onRetry,
      onReset,
      temperature: 0.6 + (variant % 3) * 0.1,
      maxTokens: 32000,
    });
    const html = extractHtml(raw);
    lastProblem = htmlProblem(html, needScript);
    if (!lastProblem) return { html: applyTheme(html, themeId), source: model };
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

/**
 * 验收用的代码视图：功能都在标记和脚本里，样式表、SVG 路径数据、注释和多余空白对判断「做没做」没有帮助。
 * 先去掉它们；仍然超长时完整保留全部脚本、截短标记部分——早期直接截取前 6 万字，
 * 8 万字的完整应用会把末尾的脚本整段截掉，Mike 因此把所有需求判为未实现（线上真实发生过）。
 */
export function compactForReview(html, limit = 110_000) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<style[^>]*>)[\s\S]*?(<\/style>)/gi, '$1/* 样式已省略 */$2')
    .replace(/\s(d|points|viewBox)="[^"]{40,}"/g, ' $1="…"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
  if (s.length <= limit) return s;
  const scripts = s.match(/<script[\s\S]*?<\/script>/gi) || [];
  const markup = s.replace(/<script[\s\S]*?<\/script>/gi, '<script>/* 见下方 */</script>');
  const scriptText = scripts.join('\n');
  const room = Math.max(20_000, limit - scriptText.length);
  return `${markup.slice(0, room)}\n<!-- 标记部分过长已截断 -->\n${scriptText}`.slice(0, limit + 40_000);
}

export async function reviewBuild({ cfg, html, checklist, signal }) {
  if (!checklist.length) return null;
  if (cfg.mockOnly) {
    return {
      source: 'mock',
      summary: '演示模式：未调用模型验收，默认视为全部满足',
      results: checklist.map((f) => ({ feature: f, ok: true, note: '演示模式' })),
    };
  }
  try {
    return await withPlannerFallback(cfg, signal, async (model) => {
      const raw = await streamChatWithRetry({
        cfg,
        model,
        signal,
        temperature: 0.1,
        maxTokens: 1500,
        messages: [
          { role: 'system', content: REVIEW_SYSTEM },
          {
            role: 'user',
            content: `需求清单：\n${checklist.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n代码：\n${compactForReview(html)}`,
          },
        ],
      });
      const review = parseReview(raw, checklist, model);
      if (!review.results) throw new Error(review.summary);
      return review;
    });
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
      features: [
        '新建任务（标题、优先级、截止日期）',
        '待办 / 进行中 / 已完成 三列',
        '拖拽卡片在列之间移动',
        '按优先级着色、逾期高亮',
        '数据自动保存',
      ],
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
  [/蓝|blue/i, '#2563eb'],
  [/绿|green/i, '#16a34a'],
  [/红|red/i, '#dc2626'],
  [/橙|orange/i, '#ea580c'],
  [/紫|purple/i, '#7c3aed'],
  [/粉|pink/i, '#db2777'],
  [/黑|black|暗/i, '#111827'],
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
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
