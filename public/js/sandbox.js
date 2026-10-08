// 预览宿主：把生成的 HTML 注入运行时后放进 sandbox iframe，
// 负责数据同步（localStorage ⇄ 云端）、Console 收集，以及自动校验打分。

let runtimeSource = null;
async function loadRuntime() {
  if (!runtimeSource) runtimeSource = await (await fetch('/js/runtime.js')).text();
  return runtimeSource;
}

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';

function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

export async function buildSrcdoc(html, { data = {}, mode = 'live', channel }) {
  const rt = await loadRuntime();
  // 禁止生成的应用发起任何网络请求（防止把用户数据外传），只允许内联脚本/样式和 data/blob 资源
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'">`;
  const boot = `${csp}<script>window.__ATOMS_INIT__=${safeJson({ data, mode, channel })};</script><script>${rt.replace(/<\/script/gi, '<\\/script')}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${boot}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${boot}</head>`);
  return `<!DOCTYPE html><html><head>${boot}</head><body>${html}</body></html>`;
}

const newChannel = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * 在 container 里挂一个可交互预览。
 * kv: { load(): Promise<object>, save({set, del}): Promise }，不传则数据只在内存里。
 */
export async function mountPreview(container, html, { kv, onConsole, onReady } = {}) {
  container.innerHTML = '';
  const channel = newChannel();
  let data = {};
  if (kv) {
    try { data = await kv.load(); } catch (e) { onConsole?.({ level: 'warn', text: `读取云端数据失败：${e.message}` }); }
  }
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('title', '应用预览');
  iframe.className = 'preview-frame';
  const handler = (e) => {
    if (e.source !== iframe.contentWindow || !e.data || e.data.__atoms !== channel) return;
    const m = e.data;
    if (m.type === 'kv' && kv) {
      kv.save({ set: m.set, del: m.del }).catch((err) => onConsole?.({ level: 'error', text: `数据保存失败：${err.message}` }));
    } else if (m.type === 'console') {
      onConsole?.({ level: m.level, text: m.text });
    } else if (m.type === 'ready') {
      onReady?.();
    }
  };
  window.addEventListener('message', handler);
  iframe.srcdoc = await buildSrcdoc(html, { data, mode: 'live', channel });
  container.appendChild(iframe);
  return {
    iframe,
    destroy() { window.removeEventListener('message', handler); iframe.remove(); },
  };
}

/** 等待 iframe 发来指定类型的消息。 */
function waitFor(iframe, channel, type, timeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { window.removeEventListener('message', h); resolve(null); }, timeout);
    function h(e) {
      if (e.source !== iframe.contentWindow || !e.data || e.data.__atoms !== channel || e.data.type !== type) return;
      clearTimeout(t);
      window.removeEventListener('message', h);
      resolve(e.data);
    }
    window.addEventListener('message', h);
  });
}

/**
 * 自动校验：在离屏 iframe 里加载应用，模拟填写输入、点击按钮，
 * 检查渲染、报错、交互响应、数据持久化与移动端适配，给出 0-100 分。
 */
export async function probeApp(html, { staticScore = 10, review = null } = {}) {
  const channel = newChannel();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:1024px;height:768px;overflow:hidden;pointer-events:none;';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.style.cssText = 'width:1024px;height:768px;border:0;';
  holder.appendChild(iframe);
  document.body.appendChild(holder);
  try {
    const ready = waitFor(iframe, channel, 'ready', 8000);
    iframe.srcdoc = await buildSrcdoc(html, { mode: 'probe', channel });
    await ready;
    await new Promise((r) => setTimeout(r, 600));
    const resultP = waitFor(iframe, channel, 'probe-result', 12000);
    iframe.contentWindow.postMessage({ __atoms: channel, type: 'probe' }, '*');
    const result = await resultP;
    iframe.style.width = '375px';
    await new Promise((r) => setTimeout(r, 250));
    const measureP = waitFor(iframe, channel, 'measure-result', 3000);
    iframe.contentWindow.postMessage({ __atoms: channel, type: 'measure' }, '*');
    const measure = await measureP;
    return scoreReport(result?.report ?? null, measure, staticScore, review);
  } finally {
    holder.remove();
  }
}

/**
 * 满分 100：沙箱实测 50（渲染 10 / 无报错 10 / 交互 15 / 持久化 10 / 移动端 5）
 * + AI 需求验收 40 + 代码完整性 10。
 */
export function scoreReport(report, measure, staticScore = 10, review = null) {
  const items = [];
  if (!report) {
    items.push({ key: 'render', label: '页面渲染', got: 0, max: 10, note: '页面没有在规定时间内完成加载' });
  } else {
    const renderOk = report.textLength > 40 && report.elements > 15;
    items.push({ key: 'render', label: '页面渲染', max: 10, got: renderOk ? 10 : report.textLength > 0 ? 5 : 0, note: `${report.elements} 个元素，${report.textLength} 字` });
    const errs = report.errors?.length ?? 0;
    items.push({ key: 'errors', label: '运行无报错', max: 10, got: Math.max(0, 10 - errs * 4), note: errs ? `${errs} 个错误：${report.errors[0]}` : '没有 JS 报错' });
    const ratio = report.clicked ? report.responsive / report.clicked : 0;
    items.push({ key: 'interact', label: '真实交互', max: 15, got: report.interactive === 0 ? 0 : Math.round(5 + 10 * ratio), note: `${report.interactive} 个可交互控件，抽测 ${report.clicked} 个，${report.responsive} 个有响应` });
    const persistGot = report.storageWrites > 0 ? 10 : report.storageReads > 0 ? 5 : 0;
    items.push({ key: 'persist', label: '数据持久化', max: 10, got: persistGot, note: report.storageWrites > 0 ? `交互后写入存储 ${report.storageWrites} 次` : report.storageReads > 0 ? '会读取存储，但交互后没有写入' : '没有使用存储' });
    const mobileOk = measure ? !measure.overflow : false;
    items.push({ key: 'mobile', label: '移动端适配', max: 5, got: measure ? (mobileOk ? 5 : 1) : 0, note: measure ? (mobileOk ? '375px 宽无横向滚动' : `375px 宽时内容宽 ${measure.scrollWidth}px，出现横向滚动`) : '未能测量' });
  }
  if (review?.results?.length) {
    const ok = review.results.filter((r) => r.ok).length;
    items.push({
      key: 'review', label: '需求覆盖', max: 40, got: Math.round((ok / review.results.length) * 40),
      note: `${ok}/${review.results.length} 项满足\n${review.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.feature}${r.note ? `（${r.note}）` : ''}`).join('\n')}`,
    });
  } else {
    items.push({ key: 'review', label: '需求覆盖', max: 40, got: 20, note: review?.summary || '未进行 AI 验收，按一半计分' });
  }
  items.push({ key: 'static', label: '代码完整性', max: 10, got: staticScore, note: staticScore >= 9 ? '文档结构完整' : '存在结构问题' });
  const score = items.reduce((s, i) => s + i.got, 0);
  return { score, items, report, review };
}
