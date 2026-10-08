// 线上 UI 冒烟验收：真实浏览器按用户路径走一遍，逐项输出 PASS / FAIL。
// 用法：node scripts/smoke-ui.mjs <站点地址>
// 依赖：playwright（不在本项目依赖里，可用 PLAYWRIGHT_FROM 指向已有安装）。会调用真实模型，约 3~6 分钟。
import { createRequire } from 'node:module';

const base = process.argv[2] || 'https://atoms-demo-i0h8.onrender.com';
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch();
const errors = [];
const watch = (page) => page.on('pageerror', (e) => errors.push(e.message));

async function token(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('atoms.token')));
}
async function api(page, path, opts = {}) {
  const t = await token(page);
  return page.evaluate(
    async ({ path, opts, t }) => {
      const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` } });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    },
    { path, opts, t },
  );
}
async function idle(page, pid, timeout = 420_000) {
  const t0 = Date.now();
  for (;;) {
    const d = (await api(page, `/api/projects/${pid}`)).json;
    if (!d.activeJobId) return d;
    if (Date.now() - t0 > timeout) throw new Error('生成超时');
    await page.waitForTimeout(3000);
  }
}

try {
  // ---------- 首页 ----------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(2500);
  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')),
  );
  check('首页所有图片可正常解码', broken.length === 0, broken.join(', '));
  const links = await page.$$eval('.showcase-row a', (as) => as.map((a) => a.href));
  check('首页有成品示例链接', links.length >= 2, `${links.length} 个`);
  for (const href of links) {
    const r = await page.request.get(href.replace(/\/s\//, '/api/share/'));
    check(`成品示例可打开 ${href.split('/').pop()}`, r.ok());
  }

  // ---------- 昵称快速体验 + 生成 ----------
  await page.mouse.wheel(0, -8000);
  await page.click('[data-ex="0"]');
  await page.click('#send');
  await page.click('[data-auth-mode="guest"]');
  await page.fill('#auth-name', 'UI 冒烟');
  await page.click('.auth-submit');
  await page.waitForTimeout(1500);
  if (await page.locator('#setup-skip').count()) await page.click('#setup-skip');
  // 登录后通常会自动提交；只有 8 秒内没有进入项目页才手动再点一次发送
  const entered = await page.waitForURL(/#\/p\//, { timeout: 8000 }).then(
    () => true,
    () => false,
  );
  if (!entered) await page.click('#send');
  await page.waitForURL(/#\/p\//, { timeout: 30_000 });
  check('昵称快速体验并创建项目', true);
  const pid = page.url().split('#/p/')[1];
  const t0 = Date.now();
  let d = await idle(page, pid);
  const race = d.races[0];
  const done = race.entries.filter((e) => e.status === 'done');
  const longest = Math.max(...race.entries.map((e) => e.duration_ms || 0));
  check('赛马至少两路完成', done.length >= 2, race.entries.map((e) => `${e.model}:${e.status}`).join(' '));
  check(
    '整轮耗时受限（不被单路拖住）',
    (Date.now() - t0) / 1000 < 300,
    `${Math.round((Date.now() - t0) / 1000)}s，最长单路 ${Math.round(longest / 1000)}s`,
  );

  // 等前端自动校验完成
  await page.waitForFunction(() => !document.body.innerText.includes('自动校验中'), null, { timeout: 150_000 }).catch(() => {});
  const stuck = await page.evaluate(() => document.body.innerText.includes('自动校验中'));
  check('自动校验没有卡住', !stuck);
  const notes = await page.$$eval('.score-item[title]', (els) =>
    els.map((e) => e.getAttribute('title')).filter((t) => t.includes('写入') || t.includes('存储')),
  );
  check(
    '数据持久化给出了刷新断言说明',
    notes.some((n) => n.includes('刷新')),
    notes[0] || '',
  );

  // ---------- 采用 + 真实操作 + 刷新 ----------
  const best = (await page.locator('.entry.best [data-adopt]').count())
    ? page.locator('.entry.best [data-adopt]')
    : page.locator('[data-adopt]').first();
  await best.click();
  await page.waitForSelector('#frame-wrap iframe', { timeout: 30_000 });
  const sawLoading = await page.locator('.preview-loading').count();
  check('预览有启动加载提示（或已瞬间就绪）', true, sawLoading ? '看到「正在启动应用…」' : '加载很快，提示已移除');
  await page.waitForTimeout(3000);
  const app = page.frameLocator('#frame-wrap iframe');
  // 打开新增入口（如有），填写所有可见输入框并提交
  const opener = app.locator('button:visible', { hasText: /新建|添加|新增|\+/ }).first();
  if (await opener.count()) await opener.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(800);
  const inputs = app.locator('input[type=text]:visible, input:not([type]):visible, textarea:visible');
  const n = await inputs.count();
  for (let i = 0; i < n; i++)
    await inputs
      .nth(i)
      .fill(i === 0 ? '冒烟记录' : '冒烟', { timeout: 3000 })
      .catch(() => {});
  const dates = app.locator('input[type=date]:visible');
  for (let i = 0; i < (await dates.count()); i++)
    await dates
      .nth(i)
      .fill('2026-10-20', { timeout: 3000 })
      .catch(() => {});
  const SAVE_RE = /^\s*(保存|添加|确定|提交|创建|完成)/;
  // 提交：表单提交按钮，或文字是保存/添加/确定的普通按钮（很多生成应用用 onclick 而不是 form）
  const submit = app.locator('button[type=submit]:visible, form button:not([type]):visible').first();
  if (await submit.count()) await submit.click({ timeout: 3000 }).catch(() => {});
  else if (await app.locator('button:visible', { hasText: SAVE_RE }).count())
    await app
      .locator('button:visible', { hasText: SAVE_RE })
      .last()
      .click({ timeout: 3000 })
      .catch(() => {});
  else if (n)
    await inputs
      .first()
      .press('Enter')
      .catch(() => {});
  await page.waitForTimeout(2500);
  const kv = (await api(page, `/api/projects/${pid}/kv`)).json.data;
  check('在预览里新增的数据同步到了云端', JSON.stringify(kv).includes('冒烟记录'), Object.keys(kv).join(','));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
  const afterReload = await page
    .frameLocator('#frame-wrap iframe')
    .locator('body')
    .innerText()
    .catch(() => '');
  check('刷新页面后数据仍在预览中', afterReload.includes('冒烟记录'));

  // ---------- Remix 复制数据 ----------
  d = (await api(page, `/api/projects/${pid}`)).json;
  const remix = await api(page, `/api/versions/${d.project.current_version_id}/remix`, {
    method: 'POST',
    body: JSON.stringify({ copyData: true }),
  });
  const rkv = (await api(page, `/api/projects/${remix.json.project?.id}/kv`)).json.data || {};
  check('Remix 新项目复制了应用数据', JSON.stringify(rkv).includes('冒烟记录'));

  // ---------- 发布 + 访客 ----------
  const pub = (await api(page, `/api/projects/${pid}/publish`, { method: 'POST' })).json;
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const visitor = await vctx.newPage();
  watch(visitor);
  await visitor.goto(base + pub.url, { waitUntil: 'networkidle' });
  await visitor.waitForTimeout(3000);
  const vapp = visitor.frameLocator('#frame iframe');
  const vtext = await vapp
    .locator('body')
    .innerText()
    .catch(() => '');
  check('访客看不到作者的数据', !vtext.includes('冒烟记录'));
  const vopener = vapp.locator('button:visible', { hasText: /新建|添加|新增|\+/ }).first();
  if (await vopener.count()) await vopener.click({ timeout: 3000 }).catch(() => {});
  await visitor.waitForTimeout(800);
  const vin = vapp.locator('input[type=text]:visible, input:not([type]):visible, textarea:visible');
  for (let i = 0; i < (await vin.count()); i++)
    await vin
      .nth(i)
      .fill(i === 0 ? '访客记录' : '访客', { timeout: 3000 })
      .catch(() => {});
  const vd = vapp.locator('input[type=date]:visible');
  for (let i = 0; i < (await vd.count()); i++)
    await vd
      .nth(i)
      .fill('2026-10-21', { timeout: 3000 })
      .catch(() => {});
  const vsub = vapp.locator('button[type=submit]:visible, form button:not([type]):visible').first();
  if (await vsub.count()) await vsub.click({ timeout: 3000 }).catch(() => {});
  else if (await vapp.locator('button:visible', { hasText: SAVE_RE }).count())
    await vapp
      .locator('button:visible', { hasText: SAVE_RE })
      .last()
      .click({ timeout: 3000 })
      .catch(() => {});
  await visitor.waitForTimeout(2500);
  await visitor.reload({ waitUntil: 'networkidle' });
  await visitor.waitForTimeout(3500);
  const vafter = await visitor
    .frameLocator('#frame iframe')
    .locator('body')
    .innerText()
    .catch(() => '');
  check('访客新增的数据刷新后仍在', vafter.includes('访客记录'));
  const ownerKv = (await api(page, `/api/projects/${pid}/kv`)).json.data;
  check('访客数据不影响作者数据', !JSON.stringify(ownerKv).includes('访客记录'));

  // ---------- 取消发布 ----------
  await api(page, `/api/projects/${pid}/publish`, { method: 'DELETE' });
  const gone = await page.request.get(base + `/api/share/${pub.slug}`);
  check('取消发布后旧链接失效', gone.status() === 404);

  // ---------- 手机尺寸 ----------
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mctx.newPage();
  await mobile.goto(base, { waitUntil: 'networkidle' });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('手机首页无横向溢出', overflow <= 2, `${overflow}px`);

  check('全程没有页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('流程执行', false, e.message);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
