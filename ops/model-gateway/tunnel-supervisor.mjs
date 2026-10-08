// 守护 Cloudflare 临时隧道：用 TCP(http2) 连接（Clash fake-ip 下 QUIC/UDP 不稳），
// 拿到新地址后把它上报给线上服务；隧道连续 3 次探测失败就重建。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DIR = new URL('.', import.meta.url).pathname;
const { token, port = 8399 } = JSON.parse(fs.readFileSync(`${DIR}gateway.config.json`, 'utf8'));
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

async function register(base) {
  for (let i = 1; i <= 8; i++) {
    // 先确认隧道本身能通，再上报（线上服务可能在休眠，最多等几分钟）
    if (await ok(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })) {
      if (
        await ok(
          `${APP}/api/admin/llm-endpoint`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ baseUrl: `${base}/v1` }),
          },
          90000,
        )
      ) {
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
  log('cloudflared exited', code);
}

for (;;) {
  await runOnce();
  await sleep(5000);
}
