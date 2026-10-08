import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChat, streamChatWithRetry, LlmError, llmConfig } from '../server/llm.js';

let server;
let baseUrl;
let calls;
let handler;

const sse = (res, parts, { finish = true } = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const p of parts) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  if (!finish) return res.end(); // 模拟上游中途断开：没有 finish_reason
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

before(async () => {
  server = http.createServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body ? JSON.parse(body) : null));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
beforeEach(() => { calls = 0; });

const cfg = () => ({ baseUrl, apiKey: 'k', models: ['m'], plannerModel: 'm', mockOnly: false });
const msgs = [{ role: 'user', content: 'hi' }];

test('streamChat: 拼接 delta 并回调 onDelta，带上 Authorization 和请求体', async () => {
  let seen;
  handler = (req, res, body) => { seen = { auth: req.headers.authorization, url: req.url, body }; sse(res, ['Hel', 'lo ', '世界']); };
  const deltas = [];
  const full = await streamChat({ cfg: cfg(), model: 'm', messages: msgs, onDelta: (d) => deltas.push(d) });
  assert.equal(full, 'Hello 世界');
  assert.deepEqual(deltas, ['Hel', 'lo ', '世界']);
  assert.equal(seen.auth, 'Bearer k');
  assert.equal(seen.url, '/chat/completions');
  assert.equal(seen.body.stream, true);
  assert.equal(seen.body.model, 'm');
});

test('streamChat: 500 抛出 retryable 的 LlmError', async () => {
  handler = (req, res) => { res.writeHead(500); res.end('boom'); };
  await assert.rejects(
    streamChat({ cfg: cfg(), model: 'm', messages: msgs }),
    (e) => e instanceof LlmError && e.retryable === true && e.status === 500,
  );
});

test('streamChat: 400 不可重试', async () => {
  handler = (req, res) => { res.writeHead(400); res.end('bad'); };
  await assert.rejects(
    streamChat({ cfg: cfg(), model: 'm', messages: msgs }),
    (e) => e instanceof LlmError && e.retryable === false && e.status === 400,
  );
});

test('streamChat: 空内容报可重试错误', async () => {
  handler = (req, res) => sse(res, []);
  await assert.rejects(streamChat({ cfg: cfg(), model: 'm', messages: msgs }), (e) => e instanceof LlmError && e.retryable);
});

test('streamChatWithRetry: 503 后重试一次并成功', async () => {
  handler = (req, res) => {
    if (calls === 1) { res.writeHead(503); res.end('busy'); } else sse(res, ['o', 'k']);
  };
  const retries = [];
  const full = await streamChatWithRetry({ cfg: cfg(), model: 'm', messages: msgs, onRetry: (e, n) => retries.push([e.status, n]) });
  assert.equal(full, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(retries, [[503, 1]]);
});

test('streamChatWithRetry: 不可重试错误不重试', async () => {
  handler = (req, res) => { res.writeHead(401); res.end('no'); };
  await assert.rejects(streamChatWithRetry({ cfg: cfg(), model: 'm', messages: msgs }), (e) => e.status === 401);
  assert.equal(calls, 1);
});

test('llmConfig: LLM_BASE_URL 为空 → mockOnly', () => {
  assert.equal(llmConfig({}).mockOnly, true);
  assert.equal(llmConfig({ LLM_BASE_URL: '', LLM_MODELS: 'a' }).mockOnly, true);
});

test('llmConfig: 完整配置解析', () => {
  const c = llmConfig({ LLM_BASE_URL: 'http://x/v1///', LLM_MODELS: ' a, b ,', LLM_API_KEY: 'k' });
  assert.equal(c.mockOnly, false);
  assert.equal(c.baseUrl, 'http://x/v1');
  assert.deepEqual(c.models, ['a', 'b']);
  assert.equal(c.plannerModel, 'a');
  assert.equal(c.apiKey, 'k');
  assert.equal(llmConfig({ LLM_BASE_URL: 'http://x', LLM_MODELS: 'a', MOCK_MODE: '1' }).mockOnly, true);
});

test('streamChat: 没有 finish_reason 就结束的流视为中途断开（partial、可重试）', async () => {
  handler = (req, res) => sse(res, ['<html><body>半截'], { finish: false });
  await assert.rejects(streamChat({ cfg: cfg(), model: 'm', messages: msgs }), (e) => e instanceof LlmError && e.retryable && e.partial);
});

test('streamChatWithRetry: 输出中途断开后整段重来，并通知 onReset', async () => {
  handler = (req, res) => (calls === 1 ? sse(res, ['半截'], { finish: false }) : sse(res, ['完整']));
  let resets = 0;
  const full = await streamChatWithRetry({ cfg: cfg(), model: 'm', messages: msgs, onReset: () => { resets += 1; } });
  assert.equal(full, '完整');
  assert.equal(calls, 2);
  assert.equal(resets, 1);
});
