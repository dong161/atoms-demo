// Atoms Demo 线上用的本地模型网关：只放行对话补全和模型列表，模型白名单 + 独立令牌 + 并发上限。
// 通过 Cloudflare 隧道暴露它，而不是直接暴露 CPA（避免管理面板 /v0/management 走隧道出去）。
import http from 'node:http';
import fs from 'node:fs';

const CFG = JSON.parse(fs.readFileSync(new URL('./gateway.config.json', import.meta.url), 'utf8'));
const { upstream, upstreamKey, token, models, port = 8399, maxConcurrent = 8 } = CFG;
let active = 0;

const deny = (res, code, msg) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: msg } }));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if ((req.headers.authorization || '') !== `Bearer ${token}`) return deny(res, 401, 'unauthorized');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return deny(res, 404, 'not found');
    if (active >= maxConcurrent) return deny(res, 429, 'too many concurrent requests');
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) return deny(res, 413, 'body too large');
      chunks.push(c);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks));
    } catch {
      return deny(res, 400, 'bad json');
    }
    if (!models.includes(body.model)) return deny(res, 400, 'model not allowed');
    active++;
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    try {
      const up = await fetch(`${upstream}/v1/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamKey}` },
        body: JSON.stringify(body),
      });
      res.writeHead(up.status, {
        'Content-Type': up.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      for await (const c of up.body) res.write(c);
      res.end();
    } catch (e) {
      if (!res.headersSent) deny(res, 502, 'upstream error');
      else res.end();
    } finally {
      active--;
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`gateway on 127.0.0.1:${port}, models: ${models.join(', ')}`));
