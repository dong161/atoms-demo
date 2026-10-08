// OpenAI 兼容的 Chat Completions 客户端（流式）。
// 配置全部来自环境变量；没配置时 isConfigured() 为 false，调用方走 mock。

const DEFAULT_TIMEOUT_MS = 180_000;
const IDLE_TIMEOUT_MS = 60_000;

export function llmConfig(env = process.env) {
  const baseUrl = (env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const models = (env.LLM_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY || '',
    models,
    plannerModel: env.LLM_PLANNER_MODEL || models[0] || '',
    mockOnly: env.MOCK_MODE === '1' || !baseUrl || models.length === 0,
  };
}

export class LlmError extends Error {
  constructor(message, { retryable = false, status, partial = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
    this.partial = partial;
  }
}

/**
 * 流式调用。onDelta(textChunk) 每收到一段内容回调一次，返回完整文本。
 * signal 可用于外部取消。
 */
export async function streamChat({ cfg, model, messages, maxTokens = 16000, temperature = 0.7, onDelta, signal }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const hardTimer = setTimeout(() => ctrl.abort(new LlmError('模型响应超时', { retryable: true })), DEFAULT_TIMEOUT_MS);
  let idleTimer;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(new LlmError('模型长时间无输出', { retryable: true })), IDLE_TIMEOUT_MS);
  };
  try {
    resetIdle();
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, temperature }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw asLlmError(e, ctrl);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`模型接口返回 ${res.status}: ${body.slice(0, 200)}`, {
        retryable: res.status === 429 || res.status >= 500,
        status: res.status,
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.error) throw new LlmError(`模型返回错误: ${JSON.stringify(json.error).slice(0, 200)}`, { retryable: true });
          if (json.choices?.[0]?.finish_reason) finished = true;
          const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
          if (delta) {
            full += delta;
            onDelta?.(delta);
          }
        }
      }
    } catch (e) {
      throw asLlmError(e, ctrl);
    }
    if (!full.trim()) throw new LlmError('模型返回了空内容', { retryable: true });
    // 上游连接中途断开时流会直接结束、没有 finish_reason，这时的内容是不完整的
    if (!finished) throw new LlmError('模型输出中途断开', { retryable: true, partial: true });
    return full;
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function asLlmError(e, ctrl) {
  if (e instanceof LlmError) return e;
  if (ctrl.signal.aborted && ctrl.signal.reason instanceof LlmError) return ctrl.signal.reason;
  if (ctrl.signal.aborted) return new LlmError('已取消');
  return new LlmError(`无法连接模型服务: ${e.message}`, { retryable: true });
}

/** 带一次重试的流式调用：只对可重试错误、且还没收到任何内容时重试。 */
export async function streamChatWithRetry(opts, { retries = 1 } = {}) {
  let attempt = 0;
  for (;;) {
    let received = false;
    try {
      return await streamChat({ ...opts, onDelta: (d) => { received = true; opts.onDelta?.(d); } });
    } catch (e) {
      if (attempt >= retries || !e.retryable || (received && !e.partial) || opts.signal?.aborted) throw e;
      attempt += 1;
      opts.onRetry?.(e, attempt);
      opts.onReset?.();
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
