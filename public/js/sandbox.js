// 预览宿主：把生成的 HTML 注入运行时后放进 sandbox iframe，
// 负责数据同步（localStorage ⇄ 云端）、Console 收集，以及自动校验打分。

let runtimeSource = null;
async function loadRuntime() {
  if (!runtimeSource) runtimeSource = await (await fetch('/js/runtime.js')).text();
  return runtimeSource;
}

// 不给 allow-popups / allow-same-origin / allow-top-navigation：生成的应用不能开新窗口、不能读平台登录态、不能跳走父页面。
// 外链由宿主确认后打开（见 open-link 消息）。
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-downloads';
const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error']);

function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
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

/**
 * 导出为独立 HTML 文件：可直接双击在浏览器里运行。
 * 若应用已有数据，注入一段只在首次打开时执行的脚本，把当前数据写入文件自己的 localStorage；之后的修改照常保存在本地。
 */
export function exportHtml(html, data = {}) {
  if (!Object.keys(data).length) return html;
  const seed = `<script>(function(){try{if(localStorage.getItem('__atoms_export_seeded'))return;var d=${safeJson(data)};for(var k in d)localStorage.setItem(k,d[k]);localStorage.setItem('__atoms_export_seeded','1')}catch(e){}})();</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${seed}`);
  return seed + html;
}

export function saveHtmlFile(name, html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const newChannel = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * KV 同步队列：合并 iframe 发来的增量，串行写入云端，失败指数退避重试。
 * 只有服务器确认成功后才移除对应变更，避免断网丢数据和并发请求乱序覆盖。
 */
export function createKvSync(save, { onError, delays = [1000, 3000, 8000, 20000] } = {}) {
  let pending = new Map(); // key -> { v } | { del: true }
  let running = false;
  let failures = 0;
  async function run() {
    if (running || !pending.size) return;
    running = true;
    while (pending.size) {
      const batch = pending;
      pending = new Map();
      const body = { set: {}, del: [] };
      for (const [k, op] of batch) {
        if (op.del) body.del.push(k);
        else body.set[k] = op.v;
      }
      try {
        await save(body);
        failures = 0;
      } catch (err) {
        // 失败：把这一批合并回去（不覆盖期间产生的更新的变更），稍后重试
        for (const [k, op] of batch) if (!pending.has(k)) pending.set(k, op);
        const delay = delays[Math.min(failures, delays.length - 1)];
        failures += 1;
        onError?.(err, failures);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    running = false;
  }
  return {
    push(set = {}, del = []) {
      for (const [k, v] of Object.entries(set)) pending.set(String(k), { v: String(v) });
      for (const k of del) pending.set(String(k), { del: true });
      run();
    },
    get size() {
      return pending.size;
    },
  };
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/**
 * 在 container 里挂一个可交互预览。
 * kv: { load(): Promise<object>, save({set, del}): Promise }，不传则数据只在内存里。
 */
export async function mountPreview(container, html, { kv, onConsole, onReady, onPicked } = {}) {
  container.innerHTML = '';
  const channel = newChannel();
  let data = {};
  if (kv) {
    try {
      data = await kv.load();
    } catch (e) {
      onConsole?.({ level: 'warn', text: `读取云端数据失败：${e.message}` });
    }
  }
  const sync = kv
    ? createKvSync(kv.save, {
        onError: (err, n) =>
          onConsole?.({ level: n >= 3 ? 'error' : 'warn', text: `数据同步失败（第 ${n} 次），稍后自动重试：${err.message}` }),
      })
    : null;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('title', '应用预览');
  iframe.className = 'preview-frame';
  const srcdoc = await buildSrcdoc(html, { data, mode: 'live', channel });
  // 来自 iframe 的消息一律当作不可信输入：逐字段校验类型和长度
  const handler = (e) => {
    if (e.source !== iframe.contentWindow || !e.data || e.data.__atoms !== channel) return;
    const m = e.data;
    if (m.type === 'kv' && sync) {
      const set = m.set && typeof m.set === 'object' ? m.set : {};
      sync.push(set, Array.isArray(m.del) ? m.del : []);
    } else if (m.type === 'console') {
      onConsole?.({ level: CONSOLE_LEVELS.has(m.level) ? m.level : 'log', text: str(m.text, 2000) });
    } else if (m.type === 'ready') {
      handle.ready = true;
      onReady?.();
    } else if (m.type === 'picked' || m.type === 'pick-cancelled') {
      const t = m.target || {};
      onPicked?.(
        m.type === 'picked'
          ? { selector: str(t.selector, 300), tag: str(t.tag, 20), text: str(t.text, 120), html: str(t.html, 801) }
          : null,
      );
    } else if (m.type === 'open-link') {
      const url = str(m.url, 2000);
      if (/^https?:\/\//i.test(url) && confirm(`这个应用想打开外部链接：\n\n${url}\n\n确定打开吗？`))
        window.open(url, '_blank', 'noopener,noreferrer');
    }
  };
  window.addEventListener('message', handler);
  // 应用若尝试把自己导航到别处（第二次 load），立即恢复原内容
  let loads = 0;
  iframe.addEventListener('load', () => {
    loads += 1;
    if (loads > 1) {
      onConsole?.({ level: 'warn', text: '应用尝试跳转到其它页面，已阻止并恢复预览' });
      loads = 0;
      iframe.srcdoc = srcdoc;
    }
  });
  iframe.srcdoc = srcdoc;
  container.appendChild(iframe);
  const handle = {
    iframe,
    /** 进入/退出点选元素模式 */
    setPick(on) {
      iframe.contentWindow?.postMessage({ __atoms: channel, type: 'pick', on: !!on }, '*');
    },
    destroy() {
      window.removeEventListener('message', handler);
      iframe.remove();
    },
  };
  return handle;
}

/** 等待 iframe 发来指定类型的消息。 */
function waitFor(iframe, channel, type, timeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      window.removeEventListener('message', h);
      resolve(null);
    }, timeout);
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
const PROBE_MARK = 'QA探针记录';

/** 两段页面文字按行比较的相似度（0~1），容忍时钟、倒计时等少量动态内容。 */
export function similarText(a = '', b = '') {
  const lines = (t) =>
    t
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const A = lines(a);
  const B = new Set(lines(b));
  if (!A.length && !B.size) return 1;
  const same = A.filter((l) => B.has(l)).length;
  return same / Math.max(A.length, B.size);
}

/** 在离屏 iframe 里加载应用，返回 { iframe, channel, holder }。 */
async function offscreen(html, data, width = 1024) {
  const channel = newChannel();
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:768px;overflow:hidden;pointer-events:none;`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.style.cssText = `width:${width}px;height:768px;border:0;`;
  holder.appendChild(iframe);
  document.body.appendChild(holder);
  const ready = waitFor(iframe, channel, 'ready', 8000);
  iframe.srcdoc = await buildSrcdoc(html, { data, mode: 'probe', channel });
  await ready;
  await new Promise((r) => setTimeout(r, 600));
  return { iframe, channel, holder };
}

/**
 * 自动校验：在离屏 iframe 里加载应用，模拟填写、提交、点击，检查渲染、报错、交互响应、
 * 移动端适配；再用交互后的数据快照重新加载一次（模拟刷新），断言数据确实能恢复。
 */
export async function probeApp(html, { staticScore = 10, review = null, timeoutMs = 45_000 } = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const run = (async () => {
    const first = await offscreen(html, {});
    let result, measure;
    try {
      const resultP = waitFor(first.iframe, first.channel, 'probe-result', 15000);
      first.iframe.contentWindow.postMessage({ __atoms: first.channel, type: 'probe' }, '*');
      result = await resultP;
      first.iframe.style.width = '375px';
      await new Promise((r) => setTimeout(r, 250));
      const measureP = waitFor(first.iframe, first.channel, 'measure-result', 3000);
      first.iframe.contentWindow.postMessage({ __atoms: first.channel, type: 'measure' }, '*');
      measure = await measureP;
    } finally {
      first.holder.remove();
    }
    const report = result?.report ?? null;
    let persisted = null;
    if (report?.snapshot) {
      const second = await offscreen(html, report.snapshot);
      try {
        const checkP = waitFor(second.iframe, second.channel, 'text-check-result', 3000);
        second.iframe.contentWindow.postMessage({ __atoms: second.channel, type: 'text-check', needle: PROBE_MARK }, '*');
        const check = await checkP;
        // 判定“刷新后没恢复”：刷新后的页面和全新打开时一样，而交互结束时明明有变化。
        // 否则视为已恢复——能看到刚填写的标记、页面与全新打开时不同、或与交互结束时一致（例如最后点了撤销）。
        persisted =
          !!check &&
          (check.found || similarText(check.text, report.initialText) < 0.98 || similarText(check.text, report.finalText) >= 0.98);
      } finally {
        second.holder.remove();
      }
    }
    return scoreReport(report, measure, staticScore, review, persisted);
  })();
  const out = await Promise.race([run, timeout]);
  clearTimeout(timer);
  if (out === 'timeout') {
    const r = scoreReport(null, null, staticScore, review);
    r.items[0].note = `校验超过 ${Math.round(timeoutMs / 1000)} 秒未完成，可点「重新校验」`;
    r.timedOut = true;
    return r;
  }
  return out;
}

/**
 * 满分 100：沙箱实测 50（渲染 10 / 无报错 10 / 交互 15 / 持久化 10 / 移动端 5）
 * + AI 需求验收 40 + 代码完整性 10。
 */
export function scoreReport(report, measure, staticScore = 10, review = null, persisted = null) {
  const items = [];
  if (!report) {
    items.push({ key: 'render', label: '页面渲染', got: 0, max: 10, note: '页面没有在规定时间内完成加载' });
  } else {
    const renderOk = report.textLength > 40 && report.elements > 15;
    const base = renderOk ? 10 : report.textLength > 0 ? 5 : 0;
    items.push({
      key: 'render',
      label: '页面渲染',
      max: 10,
      // 一打开就被弹窗或遮罩挡住，页面元素再多也不算正常渲染
      got: report.blocker ? Math.min(base, 2) : base,
      note: `${report.elements} 个元素，${report.textLength} 字${report.blocker ? `；启动时被${report.blocker.replace('：', '（')}${report.blocker.includes('：') ? '）' : ''}挡住，无法正常使用` : ''}`,
    });
    const errs = report.errors?.length ?? 0;
    items.push({
      key: 'errors',
      label: '运行无报错',
      max: 10,
      got: Math.max(0, 10 - errs * 4),
      note: errs ? `${errs} 个错误：${report.errors[0]}` : '没有 JS 报错',
    });
    const ratio = report.clicked ? report.responsive / report.clicked : 0;
    items.push({
      key: 'interact',
      label: '真实交互',
      max: 15,
      got: report.interactive === 0 ? 0 : Math.round(5 + 10 * ratio),
      note: `${report.interactive} 个可交互控件，抽测 ${report.clicked} 个，${report.responsive} 个有响应`,
    });
    // 持久化：写入后能在“刷新”后恢复才给满分
    const persistGot = report.storageWrites > 0 ? (persisted === false ? 6 : 10) : report.storageReads > 0 ? 3 : 0;
    items.push({
      key: 'persist',
      label: '数据持久化',
      max: 10,
      got: persistGot,
      note:
        report.storageWrites > 0
          ? persisted === false
            ? `交互后写入 ${report.storageWrites} 次，但模拟刷新后没有恢复刚才的数据`
            : `交互后写入 ${report.storageWrites} 次，模拟刷新后数据仍在`
          : report.storageReads > 0
            ? '会读取存储，但交互后没有写入'
            : '没有使用存储',
    });
    const mobileOk = measure ? !measure.overflow : false;
    items.push({
      key: 'mobile',
      label: '移动端适配',
      max: 5,
      got: measure ? (mobileOk ? 5 : 1) : 0,
      note: measure ? (mobileOk ? '375px 宽无横向滚动' : `375px 宽时内容宽 ${measure.scrollWidth}px，出现横向滚动`) : '未能测量',
    });
  }
  if (review?.results?.length) {
    const ok = review.results.filter((r) => r.ok).length;
    items.push({
      key: 'review',
      label: '需求覆盖',
      max: 40,
      got: Math.round((ok / review.results.length) * 40),
      note: `${ok}/${review.results.length} 项满足\n${review.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.feature}${r.note ? `（${r.note}）` : ''}`).join('\n')}`,
    });
  } else {
    items.push({ key: 'review', label: '需求覆盖', max: 40, got: 20, note: review?.summary || '未进行 AI 验收，按一半计分' });
  }
  items.push({ key: 'static', label: '代码完整性', max: 10, got: staticScore, note: staticScore >= 9 ? '文档结构完整' : '存在结构问题' });
  const score = items.reduce((s, i) => s + i.got, 0);
  return { score, items, report, review };
}
