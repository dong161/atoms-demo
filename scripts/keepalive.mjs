import { pathToFileURL } from 'node:url';
export const HEALTH_URL = 'https://atoms-demo-i0h8.onrender.com/api/health';
export async function checkHealth(url = HEALTH_URL, { timeoutMs = 60_000 } = {}) {
  const start = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let data;
  try { data = await response.json(); } catch { throw new Error('HTTP200但非JSON健康响应（可能仍在冷启动）'); }
  if (!data || typeof data !== 'object' || data.ok !== true || data.db !== 'postgres') throw new Error('健康状态异常或数据库不是postgres');
  return { ok: true, db: data.db, mock: data.mock, commit: data.commit, latencyMs: Date.now() - start };
}
export async function runKeepalive({ url = HEALTH_URL, attempts = 3, delayMs = 10_000, timeoutMs = 60_000, log = console.log } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await checkHealth(url, { timeoutMs });
      log(JSON.stringify({ time: new Date().toISOString(), attempt, ...result }));
      return 0;
    } catch (error) {
      log(JSON.stringify({ time: new Date().toISOString(), attempt, error: error.message }));
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runKeepalive();
