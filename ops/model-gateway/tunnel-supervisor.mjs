// 守护 Cloudflare 临时隧道：用 TCP(http2) 连接（Clash fake-ip 下 QUIC/UDP 不稳），
// 拿到新地址后把它上报给线上服务；隧道连续 3 次探测失败就重建。
// 同时每 10 分钟逐个试一遍白名单模型，只上报当前能正常回复的，线上赛马阵容就不会挑到已经坏掉的模型。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DIR = new URL('.', import.meta.url).pathname;
const { token, port = 8399, models = [] } = JSON.parse(fs.readFileSync(`${DIR}gateway.config.json`, 'utf8'));
const APP = 'https://atoms-demo-i0h8.onrender.com';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ok(url, opts = {}, timeout = 20000) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
    return r.ok;
  } catch {
    return false;
  }
}

// 主力阵容：Claude、Gemini、GPT 三家（按此顺序，第一个也是 Mike 规划/验收的首选）。
// 三家都可用时只上报它们；有哪家暂时不通，才从其它可用模型里补位凑满 3 路，恢复后下一轮巡检自动换回。
const PREFERRED = [/claude/i, /gemini/i, /gpt/i];
function pickLineup(alive) {
  const main = PREFERRED.map((re) => alive.find((m) => re.test(m))).filter(Boolean);
  const backup = alive.filter((m) => !main.includes(m));
  return [...main, ...backup.slice(0, Math.max(0, 3 - main.length))];
}

// 逐个用一句极短的请求试模型（并行，45 秒内没有正常回复算不可用）；全部失败时退回完整清单，避免线上无模型可选
let liveModels = models;
async function probeModels() {
  const results = await Promise.all(
    models.map(async (model) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：正常' }], max_tokens: 20 }),
          signal: AbortSignal.timeout(45000),
        });
        const j = await r.json().catch(() => null);
        return r.ok && j?.choices?.[0]?.message?.content ? model : null;
      } catch {
        return null;
      }
    }),
  );
  const alive = results.filter(Boolean);
  const down = models.filter((m) => !alive.includes(m));
  log(`model probe: ${alive.length}/${models.length} ok${down.length ? `, down: ${down.join(', ')}` : ''}`);
  return alive.length ? pickLineup(alive) : pickLineup(models);
}

async function report(base) {
  return ok(
    `${APP}/api/admin/llm-endpoint`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ baseUrl: `${base}/v1`, models: liveModels }), // 只上报当前可用的模型
    },
    90000,
  );
}

async function register(base) {
  for (let i = 1; i <= 8; i++) {
    // 先确认隧道本身能通，再上报（线上服务可能在休眠，最多等几分钟）
    if (await ok(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })) {
      liveModels = await probeModels();
      if (await report(base)) {
        log('registered', base);
        return true;
      }
    }
    log(`register attempt ${i} failed, retrying`);
    await sleep(15000);
  }
  return false;
}

async function runOnce() {
  const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let base = null;
  let registered = false;
  let registering = false;
  const tryRegister = async () => {
    if (registered || registering || !base) return;
    registering = true;
    registered = await register(base);
    registering = false;
  };
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !base) {
      base = m[0];
      fs.writeFileSync(`${DIR}tunnel.url`, base);
      log('tunnel up', base);
      tryRegister();
    }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  const exited = new Promise((r) => cf.on('exit', (code) => r(code)));
  // 模型巡检：每 10 分钟重新试一遍，可用清单有变化就重新上报
  const modelTimer = setInterval(async () => {
    if (!registered || !base) return;
    const next = await probeModels();
    if (next.join(',') === liveModels.join(',')) return;
    liveModels = next;
    if (await report(base)) log('re-reported models', liveModels.join(', '));
  }, 10 * 60_000);
  // 健康巡检：每 2 分钟探测一次，连续 3 次失败就重建隧道
  let fails = 0;
  const timer = setInterval(async () => {
    if (!base) return;
    if (await ok(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })) {
      fails = 0;
      tryRegister(); // 隧道恢复后补报（例如之前因网络规则未生效而放弃）
      return;
    }
    fails += 1;
    log(`probe failed ${fails}/3`);
    if (fails >= 3) cf.kill('SIGTERM');
  }, 120000);
  const code = await exited;
  clearInterval(timer);
  clearInterval(modelTimer);
  log('cloudflared exited', code);
}

// 第二层保活：GitHub 定时任务可能延迟，本机每 10 分钟访问一次线上健康检查，防止 Render 免费实例休眠
setInterval(() => {
  ok(`${APP}/api/health`, {}, 90000).then((alive) => alive || log('keepalive: health check failed'));
}, 10 * 60_000);

for (;;) {
  await runOnce();
  await sleep(5000);
}
