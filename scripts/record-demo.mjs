// 录制演示视频：用 Playwright 无头浏览器按评委视角走完整流程，等待模型的片段在后期加速。
// 用法：node scripts/record-demo.mjs <站点地址> <输出 mp4>
// 依赖：playwright（不在本项目依赖里，需自行安装或用 PLAYWRIGHT_FROM 指定已有安装）、ffmpeg。
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const base = process.argv[2] || 'https://atoms-demo-i0h8.onrender.com';
const out = path.resolve(process.argv[3] || 'demo.mp4');
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');

const W = 1440;
const H = 900;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atoms-demo-video-'));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir, size: { width: W, height: H } },
  locale: 'zh-CN',
});
const page = await context.newPage();
const t0 = Date.now();
const waits = []; // [开始秒, 结束秒]：后期加速的等待片段
const sec = () => (Date.now() - t0) / 1000;
const pause = (ms) => page.waitForTimeout(ms);

async function caption(text) {
  await page.evaluate((text) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.style.cssText =
        'position:fixed;left:24px;bottom:24px;z-index:99999;max-width:560px;padding:12px 18px;border-radius:14px;background:rgba(20,22,40,.88);color:#fff;font:600 18px/1.5 -apple-system,"PingFang SC",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }, text);
}

async function waitPhase(fn) {
  const start = sec();
  await fn();
  waits.push([start, sec()]);
}

async function jobIdle(timeout = 360_000) {
  // 生成中会显示「停止」按钮，结束后消失
  await page.waitForSelector('#stop-btn', { timeout: 15_000 }).catch(() => {});
  await page.waitForSelector('#stop-btn', { state: 'detached', timeout });
}

// 修改也走赛马时，完成后停在赛马对比页：等打分结束后采用推荐的候选
async function adoptIfRacing() {
  if (!(await page.locator('[data-adopt]').count())) return;
  await page.waitForFunction(() => !document.body.innerText.includes('自动校验中'), null, { timeout: 120_000 }).catch(() => {});
  await pause(2500);
  const best = page.locator('.entry.best [data-adopt]');
  await ((await best.count()) ? best : page.locator('[data-adopt]').first()).click();
  await pause(3000);
}

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await caption('Atoms Demo：一句话生成可运行的网页应用');
  await pause(2500);
  await page.mouse.wheel(0, 1400);
  await pause(2500);
  await page.mouse.wheel(0, 1400);
  await pause(2000);
  await page.mouse.wheel(0, -4000);
  await pause(1000);

  await caption('① 选一个示例，或者自己写一句需求');
  await page.click('[data-ex="0"]');
  await pause(2000);
  await page.click('#send');
  await pause(1200);

  await caption('② 仅用昵称快速体验（也支持邮箱密码注册）');
  if (await page.locator('[data-auth-mode="guest"]').count()) {
    await page.click('[data-auth-mode="guest"]');
    await pause(600);
    await page.fill('#auth-name', '评委体验');
    await pause(600);
    await page.click('.auth-submit');
  }
  await pause(2000);
  if (await page.locator('#setup-skip').count()) await page.click('#setup-skip');
  await pause(800);
  if (!page.url().includes('#/p/') && (await page.locator('#send').count())) await page.click('#send');
  await page.waitForURL(/#\/p\//, { timeout: 30_000 });

  await caption('③ Mike 拆解需求，三路模型同时开发（赛马模式），代码实时输出');
  await pause(6000);
  await waitPhase(async () => {
    await page.waitForSelector('[data-adopt]', { timeout: 360_000 });
    await jobIdle();
    // 等所有候选完成自动校验打分
    await page.waitForFunction(() => !document.body.innerText.includes('自动校验中'), null, { timeout: 120_000 }).catch(() => {});
  });
  await caption('④ 沙箱自动实测打分 + Mike 逐条验收，推荐最优候选');
  await pause(1500);
  const review = page.locator('details.review summary').first();
  if (await review.count()) await review.click();
  await pause(4000);

  await caption('⑤ 全屏试用候选：真实可交互');
  const tryBtn = (await page.locator('.entry.best [data-try]').count())
    ? page.locator('.entry.best [data-try]')
    : page.locator('[data-try]').first();
  await tryBtn.click();
  await pause(2500);
  const app = page.frameLocator('#frame-wrap iframe');
  const input = app.locator('input[type=text], input:not([type]), textarea').first();
  if (await input.count()) {
    await input.fill('准备评审材料');
    await input.press('Enter');
  }
  await pause(1500);
  const btn = app.locator('button').first();
  if (await btn.count()) await btn.click().catch(() => {});
  await pause(2500);

  await caption('⑥ 采用这个版本（Version 1），数据会同步到云端');
  await page.click('#adopt-btn');
  await pause(3500);

  await caption('⑦ 对话修改：在当前版本上迭代');
  await page.fill('#chat-input', '把主色改成绿色，并在顶部加一个任务完成率进度条');
  await pause(1200);
  await page.press('#chat-input', 'Enter');
  await waitPhase(() => jobIdle());
  await adoptIfRacing();
  await pause(2500);

  await caption('⑧ 点选元素修改：只改你点中的那个元素');
  if (await page.locator('#vt-pick').count()) {
    await page.click('#vt-pick');
    await pause(1200);
    await page.frameLocator('#frame-wrap iframe').locator('h1, h2').first().click();
    await pause(1500);
    await page.fill('#chat-input', '把这个标题改成「我的团队看板」，字号再大一些');
    await pause(1200);
    await page.press('#chat-input', 'Enter');
    await waitPhase(() => jobIdle());
    await adoptIfRacing();
    await pause(2500);
  }

  await caption('⑨ 版本历史：随时预览、回退，或 Remix 成新项目');
  await page.click('#ws-history');
  await pause(3500);
  await page.click('#drawer-close').catch(() => {});
  await pause(800);

  await caption('⑩ 一键发布，得到分享链接');
  await page.click('#ws-publish');
  await pause(3000);
  const url = (await page.locator('.modal .code-box').textContent()).trim();
  await page.click('#pub-ok');
  await pause(800);

  await page.goto(url, { waitUntil: 'networkidle' });
  await caption('⑪ 访客打开分享链接直接使用，数据与作者互相独立');
  await pause(4000);
  await page.reload({ waitUntil: 'networkidle' });
  await caption('刷新后数据仍在 —— 完整闭环：输入 → 生成 → 预览 → 迭代 → 保存 → 分享');
  await pause(5000);
} finally {
  await context.close();
  await browser.close();
}

// 后期：等待片段 8 倍速，其余原速
const webm = fs.readdirSync(dir).find((f) => f.endsWith('.webm'));
const src = path.join(dir, webm);
const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString().trim());
const segs = [];
let cur = 0;
for (const [a, b] of waits) {
  if (a > cur) segs.push([cur, a, 1]);
  segs.push([a, Math.min(b, total), 8]);
  cur = Math.min(b, total);
}
if (cur < total) segs.push([cur, total, 1]);
const parts = segs.map(([a, b, k], i) => `[0:v]trim=${a.toFixed(2)}:${b.toFixed(2)},setpts=(PTS-STARTPTS)/${k}[v${i}]`);
const filter = `${parts.join(';')};${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[out]`;
execFileSync('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-i',
  src,
  '-filter_complex',
  filter,
  '-map',
  '[out]',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-crf',
  '28',
  '-preset',
  'veryfast',
  out,
]);
console.log('saved', out, 'raw', total.toFixed(0) + 's', 'segments', segs.length);
