// 首页分区内容。所有图片均为本项目 AI 原创生成，见 public/img/ATTRIBUTION.md。
// 角色头像与插画均为本项目 AI 原创生成（见 public/img/ATTRIBUTION.md）
export const agentAvatars = {
  mike: '/img/agent-mike.webp',
  emma: '/img/agent-emma.webp',
  bob: '/img/agent-bob.webp',
  alex: '/img/agent-alex.webp',
  david: '/img/agent-david.webp',
};
export function landingSections() {
  const cases = [
    ['case-kanban', '任务看板', '优先级、截止日、拖拽排序，一句话就能用'],
    ['case-portfolio', '个人作品集', '可在线编辑的主页，内容自动保存'],
    ['case-calculator', '实用小工具', '房贷计算、提前还款对比，结果留存'],
  ];
  return `<section class="landing-section" id="how-it-works"><div class="section-eyebrow">FROM IDEA TO INTERACTION</div><h2>不止生成页面。<br>让想法跑起来。</h2><figure class="hero-visual"><img src="/img/hero-visual.webp" alt="一句话需求被多路模型同时实现，择优胜出的示意图" loading="lazy"></figure><div class="journey-grid">
    <article><span class="journey-number">01</span><h3>说出你的想法</h3><p>像和同事聊天一样，描述场景、功能和风格。AI 团队先拆解需求。</p><div class="mini-chat">“我想做一个可以记录喝水的工具。”<span>Mike · 正在整理需求 ✓</span></div></article>
    <article><span class="journey-number">02</span><h3>比较，更好的答案</h3><p>最多三路模型并行开发，展示进度和校验结果。由你选择采用。</p><div class="mini-race"><span>候选 A <i style="--bar:82%"></i></span><span>候选 B <i style="--bar:94%"></i></span><span>候选 C <i style="--bar:72%"></i></span><small>流程示意 · 非实际评分</small></div></article>
    <article><span class="journey-number">03</span><h3>边用，边迭代</h3><p>点击预览、对话修改、切换版本。一键发布，把链接分享给别人。</p><div class="mini-publish"><span>◎</span><b>你的想法，已上线</b><small>预览 → 修改 → 发布</small></div></article></div></section>
    <section class="landing-section inspiration" id="inspiration"><div class="section-heading"><div><div class="section-eyebrow">A LITTLE INSPIRATION</div><h2>下一次灵感，从这里开始。</h2></div></div><p class="section-caption">点一张卡片，直接用它作为你的第一句需求。</p><div class="inspiration-grid">${cases.map(([slug, title, desc], i) => `<button class="inspiration-card" data-inspire="${i}"><div class="inspiration-image"><img src="/img/${slug}.webp" alt="${title}示意图" loading="lazy"><span>示例方向</span></div><h3>${title} <span>↗</span></h3><p>${desc}</p></button>`).join('')}</div></section>
    <section class="landing-section team-section" id="team"><div class="team-intro"><div class="section-eyebrow">MEET YOUR AI TEAM</div><h2>想法属于你。<br>执行交给团队。</h2><p>从方案到代码，角色化流程让每一步可见。Mike 负责需求拆解与验收，Alex 负责写代码与修改；其余角色用于展示团队分工，后续可扩展。</p></div><div class="team-cards">${[
      ['mike', 'Mike', '需求拆解'],
      ['alex', 'Alex', '工程生成'],
      ['emma', 'Emma', '产品角色'],
      ['bob', 'Bob', '架构角色'],
      ['david', 'David', '数据角色'],
    ]
      .map(
        ([k, n, r]) =>
          `<div class="team-card"><img src="${agentAvatars[k]}" alt="${n} · ${r}" loading="lazy"><b>${n}</b><small>${r}</small></div>`,
      )
      .join('')}</div></section>
    <section class="landing-cta"><div class="section-eyebrow">YOUR NEXT IDEA STARTS HERE</div><h2>把“要是有个工具就好了”，<br>变成一个真的工具。</h2><button class="btn primary" id="bottom-start">开始我的第一个项目 ↗</button><span>支持轻量体验 · 也可用邮箱密码保存账号</span></section>
    <footer class="landing-footer"><a class="logo" href="#/"><span class="logo-mark">◎</span>Atoms <small>DEMO</small></a><p>独立笔试演示项目，非 Atoms 官方产品。<br>页面中的角色头像与插画均为本项目 AI 原创生成。</p><a href="https://github.com/dong161/atoms-demo" target="_blank" rel="noopener noreferrer">源代码 ↗</a></footer>`;
}
export const inspirationPrompts = [
  '做一个项目看板：任务有优先级和截止日期，可以在待办/进行中/已完成之间拖拽，逾期任务高亮。',
  '做一个可编辑的个人作品集主页：头像、简介、技能标签、项目经历和联系方式，编辑后自动保存。',
  '做一个房贷计算器，支持等额本息和等额本金，能对比提前还款节省的利息，并保存最近的计算记录。',
];

// 预先用真实模型生成并发布的成品示例：不想等生成也能先体验最终效果（数据按访客独立保存）
export const showcases = [
  { title: '项目任务看板', url: '/s/Db5GK2OY' },
  { title: '每日喝水打卡', url: '/s/doS6R8zF' },
];
