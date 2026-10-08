// 注入到「生成的应用」里的运行时（作为 <head> 第一个脚本执行）。
// 预览 iframe 是 sandbox 且没有 allow-same-origin，应用拿不到平台的登录态；
// 这里用一个 localStorage 替身把数据通过 postMessage 交给宿主页，由宿主写进云端数据库。
// 同时收集报错、console 输出，并响应「自动校验」探针。
(function () {
  var INIT = window.__ATOMS_INIT__ || { data: {}, mode: 'live', channel: '' };
  var probeMode = INIT.mode === 'probe';
  function post(msg) {
    msg.__atoms = INIT.channel;
    try {
      parent.postMessage(msg, '*');
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- localStorage 替身 ----------
  var data = new Map(Object.entries(INIT.data || {}));
  var stats = { reads: 0, writes: 0 };
  var pending = { set: {}, del: {} };
  var timer = null;
  function flush() {
    timer = null;
    var set = pending.set,
      del = Object.keys(pending.del);
    pending = { set: {}, del: {} };
    if (!probeMode && (Object.keys(set).length || del.length)) post({ type: 'kv', set: set, del: del });
  }
  function queue() {
    if (!timer) timer = setTimeout(flush, 300);
  }
  function makeStore(persist) {
    var map = persist ? data : new Map();
    return {
      getItem: function (k) {
        stats.reads++;
        k = String(k);
        return map.has(k) ? map.get(k) : null;
      },
      setItem: function (k, v) {
        k = String(k);
        v = String(v);
        map.set(k, v);
        if (persist) {
          stats.writes++;
          pending.set[k] = v;
          delete pending.del[k];
          queue();
        }
      },
      removeItem: function (k) {
        k = String(k);
        map.delete(k);
        if (persist) {
          stats.writes++;
          pending.del[k] = 1;
          delete pending.set[k];
          queue();
        }
      },
      clear: function () {
        if (persist) {
          map.forEach(function (_, k) {
            pending.del[k] = 1;
          });
          pending.set = {};
          stats.writes++;
          queue();
        }
        map.clear();
      },
      key: function (i) {
        return Array.from(map.keys())[i] || null;
      },
      get length() {
        return map.size;
      },
    };
  }
  var local = makeStore(true);
  var session = makeStore(false);
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: function () {
        return local;
      },
    });
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: function () {
        return session;
      },
    });
  } catch (e) {
    /* 极少数浏览器不允许覆盖，忽略 */
  }
  window.addEventListener('pagehide', flush);

  // ---------- 报错与日志 ----------
  var errors = [];
  function fmt(a) {
    try {
      return typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }
  window.addEventListener('error', function (e) {
    var m = (e.message || '脚本错误') + (e.lineno ? ' (行 ' + e.lineno + ')' : '');
    errors.push(m);
    post({ type: 'console', level: 'error', text: m });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var m = '未处理的 Promise 异常：' + fmt(e.reason);
    errors.push(m);
    post({ type: 'console', level: 'error', text: m });
  });
  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var text = Array.prototype.map.call(arguments, fmt).join(' ');
      if (level === 'error') errors.push(text);
      post({ type: 'console', level: level, text: text.slice(0, 2000) });
      return orig.apply(console, arguments);
    };
  });

  // 拦截跳出预览的导航（外链在新窗口打开）
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
    e.preventDefault();
    if (!probeMode) window.open(a.href, '_blank', 'noopener');
  });
  window.addEventListener('submit', function (e) {
    e.preventDefault();
  });

  // ---------- 自动校验探针 ----------
  if (probeMode) {
    window.alert = function () {};
    window.confirm = function () {
      return true;
    };
    window.prompt = function () {
      return '测试';
    };
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }
  function sampleFor(input) {
    var t = (input.type || 'text').toLowerCase();
    if (t === 'number' || t === 'range') return input.min && +input.min > 0 ? input.min : '12';
    if (t === 'date') return new Date().toISOString().slice(0, 10);
    if (t === 'email') return 'test@example.com';
    if (t === 'color') return '#3366ff';
    return '测试内容';
  }
  function setValue(el, v) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function wait(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function runProbe() {
    var body = document.body || document.documentElement;
    var report = {
      textLength: (body.innerText || '').trim().length,
      elements: body.querySelectorAll('*').length,
      initialErrors: errors.length,
    };
    var inputs = Array.prototype.filter
      .call(
        document.querySelectorAll(
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]):not([type=button]), textarea',
        ),
        visible,
      )
      .slice(0, 6);
    inputs.forEach(function (el) {
      if (!el.disabled && !el.readOnly) {
        try {
          setValue(el, sampleFor(el));
        } catch (e) {
          /* ignore */
        }
      }
    });
    report.inputs = inputs.length;

    var clickable = Array.prototype.filter.call(
      document.querySelectorAll(
        'button, [role=button], input[type=checkbox], input[type=radio], input[type=submit], select, a[href^="#"], [onclick]',
      ),
      function (el) {
        return visible(el) && !el.disabled;
      },
    );
    report.interactive = clickable.length;
    var writesBefore = stats.writes;
    var responsive = 0,
      tried = 0;
    for (var i = 0; i < clickable.length && tried < 8; i++) {
      var el = clickable[i];
      if (!el.isConnected) continue;
      tried++;
      var changed = 0;
      var mo = new MutationObserver(function (list) {
        changed += list.length;
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      var before = (document.body.innerText || '').length;
      try {
        if (el.tagName === 'SELECT') {
          if (el.options.length > 1) {
            el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else {
          el.click();
        }
      } catch (e) {
        errors.push('点击出错：' + e.message);
      }
      await wait(160);
      mo.disconnect();
      if (changed > 0 || (document.body.innerText || '').length !== before) responsive++;
    }
    report.clicked = tried;
    report.responsive = responsive;
    report.storageWrites = stats.writes - writesBefore;
    report.storageReads = stats.reads;
    report.errors = errors.slice(0, 10);
    return report;
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.__atoms !== INIT.channel) return;
    if (m.type === 'probe')
      runProbe().then(function (r) {
        post({ type: 'probe-result', report: r });
      });
    if (m.type === 'measure') {
      var de = document.documentElement;
      post({
        type: 'measure-result',
        overflow: de.scrollWidth > window.innerWidth + 2,
        scrollWidth: de.scrollWidth,
        width: window.innerWidth,
      });
    }
  });

  window.addEventListener('load', function () {
    post({ type: 'ready' });
  });
})();
