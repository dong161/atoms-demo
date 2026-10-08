// Public Atoms homepage images are remote references, not bundled or represented as our own work.
export const officialAssets = {
  mike: 'https://public-frontend-cos.metadl.com/nuxt-mgx/prod/assets/Mike-TeamLeader-Avatar_origin.DmBYWaXT.webp',
  emma: 'https://public-frontend-cos.metadl.com/nuxt-mgx/prod/assets/Emma-ProductManager-Avatar_origin.BBeqkRr7.webp',
  bob: 'https://public-frontend-cos.metadl.com/nuxt-mgx/prod/assets/Bob-Architect-Avatar_origin.Cdi-oMPW.webp',
  alex: 'https://public-frontend-cos.metadl.com/nuxt-mgx/prod/assets/Alex-Engineer-Avatar_origin.zHMG8gqX.webp',
  david: 'https://public-frontend-cos.metadl.com/nuxt-mgx/prod/assets/David-DataAnalyst-Avatar_origin.CahzHabe.webp',
};
export function landingSections() {
  const cases = [['pizzeria-website','餐饮品牌网站','从一道招牌菜，讲好品牌故事'],['portfolio-website','个人作品集','让作品成为最好的自我介绍'],['mental-wellness-platform','服务产品页面','把服务变成清晰的在线体验']];
  return `<section class="landing-section" id="how-it-works"><div class="section-eyebrow">FROM IDEA TO INTERACTION</div><h2>不止生成页面。<br>让想法跑起来。</h2><div class="journey-grid">
    <article><span class="journey-number">01</span><h3>说出你的想法</h3><p>像和同事聊天一样，描述场景、功能和风格。AI 团队先拆解需求。</p><div class="mini-chat">“我想做一个可以记录喝水的工具。”<span>Mike · 正在整理需求 ✓</span></div></article>
    <article><span class="journey-number">02</span><h3>比较，更好的答案</h3><p>最多三路模型并行开发，展示进度和校验结果。由你选择采用。</p><div class="mini-race"><span>候选 A <i style="--bar:82%"></i></span><span>候选 B <i style="--bar:94%"></i></span><span>候选 C <i style="--bar:72%"></i></span><small>流程示意 · 非实际评分</small></div></article>
    <article><span class="journey-number">03</span><h3>边用，边迭代</h3><p>点击预览、对话修改、切换版本。一键发布，把链接分享给别人。</p><div class="mini-publish"><span>◎</span><b>你的想法，已上线</b><small>预览 → 修改 → 发布</small></div></article></div></section>
    <section class="landing-section inspiration" id="inspiration"><div class="section-heading"><div><div class="section-eyebrow">A LITTLE INSPIRATION</div><h2>下一次灵感，从这里开始。</h2></div><a href="https://atoms.dev/discover" target="_blank" rel="noopener noreferrer">查看官网案例 ↗</a></div><p class="section-caption">以下为 Atoms 官网设计参考，不是本站生成案例；点击卡片可选用相应的创作提示。</p><div class="inspiration-grid">${cases.map(([slug,title,desc],i)=>`<button class="inspiration-card" data-inspire="${i}"><div class="inspiration-image"><img src="https://public-frontend-cos.metadl.com/commonfile/home/v1.3.x/ab-2.0.1/posters/${slug}.webp" alt="Atoms 官网参考：${title}" loading="lazy" referrerpolicy="no-referrer"><span>官网设计参考</span></div><h3>${title} <span>↗</span></h3><p>${desc}</p></button>`).join('')}</div></section>
    <section class="landing-section team-section" id="team"><div class="team-intro"><div class="section-eyebrow">MEET YOUR AI TEAM</div><h2>想法属于你。<br>执行交给团队。</h2><p>从方案到代码，角色化流程让每一步可见。人物视觉参考 Atoms 官网，本站已实现需求拆解与工程生成，其余角色用于流程说明。</p></div><div class="team-cards">${[['mike','Mike','需求拆解'],['alex','Alex','工程生成'],['emma','Emma','产品角色'],['bob','Bob','架构角色'],['david','David','数据角色']].map(([k,n,r])=>`<div class="team-card"><img src="${officialAssets[k]}" alt="${n} · ${r}" loading="lazy" referrerpolicy="no-referrer"><b>${n}</b><small>${r}</small></div>`).join('')}</div></section>
    <section class="landing-cta"><div class="section-eyebrow">YOUR NEXT IDEA STARTS HERE</div><h2>把“要是有个工具就好了”，<br>变成一个真的工具。</h2><button class="btn primary" id="bottom-start">开始我的第一个项目 ↗</button><span>支持轻量体验 · 也可用邮箱密码保存账号</span></section>
    <footer class="landing-footer"><a class="logo" href="#/"><span class="logo-mark">◎</span>Atoms <small>DEMO</small></a><p>独立笔试演示项目，非 Atoms 官方产品。<br>人物与参考案例图片来源：<a href="https://atoms.dev/" target="_blank" rel="noopener noreferrer">Atoms 官网</a>；版权归原权利人。</p><a href="https://github.com/dong161/atoms-demo" target="_blank" rel="noopener noreferrer">源代码 ↗</a></footer>`;
}
export const inspirationPrompts = ['做一个餐饮品牌网站，有菜单、营业时间和可编辑的餐厅介绍，不要虚构真实订单或支付。','做一个可编辑的个人作品集，支持新增项目、技能和联系方式，内容自动保存。','做一个每日心情记录工具，可以记录心情和日记、查看趋势，不提供医疗诊断。'];
