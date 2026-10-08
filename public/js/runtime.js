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

  // 拦截跳出预览的导航（外链交给宿主确认）
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
    e.preventDefault();
    // 预览没有弹窗权限：外链交给宿主页确认后再打开
    if (!probeMode) post({ type: 'open-link', url: a.href });
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

  var TEXT_INPUTS =
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]):not([type=button]):not([type=range]):not([type=color]), textarea';
  // 填写所有空的可见输入框（重新渲染后输入框可能被清空，所以每次点击前都补一遍）
  function fillEmpty(root) {
    var n = 0;
    Array.prototype.forEach.call((root || document).querySelectorAll(TEXT_INPUTS), function (el) {
      if (!visible(el) || el.disabled || el.readOnly || el.value) return;
      try {
        setValue(el, sampleFor(el));
        n++;
      } catch (e) {
        /* ignore */
      }
    });
    return n;
  }
  function label(el) {
    return ((el.innerText || el.value || el.getAttribute('aria-label') || el.title || '') + '').trim();
  }
  var ADD_RE = /添加|新增|新建|保存|记录|提交|创建|打卡|开始|计算|确定|add|save|create|submit|start|\+/i;
  var DANGER_RE = /删除|清空|重置|移除|delete|clear|reset|remove|×|✕/i;

  async function measureClick(el) {
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
    return changed > 0 || (document.body.innerText || '').length !== before;
  }

  async function runProbe() {
    var body = document.body || document.documentElement;
    var report = {
      textLength: (body.innerText || '').trim().length,
      elements: body.querySelectorAll('*').length,
      initialErrors: errors.length,
    };
    var writesBefore = stats.writes;
    report.inputs = fillEmpty(document);

    // 先处理表单：填好再提交，模拟“新增一条数据”这类最典型的操作
    var forms = Array.prototype.filter.call(document.querySelectorAll('form'), visible).slice(0, 3);
    var responsive = 0,
      tried = 0;
    for (var f = 0; f < forms.length; f++) {
      var form = forms[f];
      if (!form.isConnected) continue;
      fillEmpty(form);
      var submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
      tried++;
      if (submit && visible(submit) && !submit.disabled) {
        if (await measureClick(submit)) responsive++;
      } else {
        var changedBefore = stats.writes;
        try {
          form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        } catch (e) {
          errors.push('提交出错：' + e.message);
        }
        await wait(160);
        if (stats.writes > changedBefore) responsive++;
      }
    }

    // 再点其它控件：可能写入数据的按钮优先，删除/清空类放最后。
    // 每次点击后重新收集（点击可能展开新的按钮，比如“编辑”后出现“添加”）
    var CLICKABLE = 'button, [role=button], input[type=checkbox], input[type=radio], input[type=submit], select, a[href^="#"], [onclick]';
    var clicked = new Set();
    var rank = function (el) {
      var t = label(el);
      return DANGER_RE.test(t) ? 2 : ADD_RE.test(t) ? 0 : 1;
    };
    var candidates = function () {
      return Array.prototype.filter
        .call(document.querySelectorAll(CLICKABLE), function (el) {
          return visible(el) && !el.disabled && !clicked.has(el) && !(el.form && forms.indexOf(el.form) >= 0 && el.type === 'submit');
        })
        .sort(function (x, y) {
          return rank(x) - rank(y);
        });
    };
    report.interactive = candidates().length;
    while (tried < 10) {
      var next = candidates()[0];
      if (!next) break;
      clicked.add(next);
      tried++;
      fillEmpty(document);
      if (await measureClick(next)) responsive++;
    }
    report.clicked = tried;
    report.responsive = responsive;
    report.forms = forms.length;
    report.storageWrites = stats.writes - writesBefore;
    report.storageReads = stats.reads;
    report.errors = errors.slice(0, 10);
    return report;
  }

  // ---------- 点选元素（对应 Atoms 的 Design / Select to Chat） ----------
  var picking = false;
  var hoverEl = null;
  function ensurePickStyle() {
    if (document.getElementById('atoms-pick-style')) return;
    var st = document.createElement('style');
    st.id = 'atoms-pick-style';
    st.textContent =
      '.atoms-pick-hover{outline:2px solid #6d5efc!important;outline-offset:2px!important;cursor:crosshair!important}' +
      '.atoms-pick-on,.atoms-pick-on *{cursor:crosshair!important}';
    document.head.appendChild(st);
  }
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 6) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
        parts.unshift('#' + el.id);
        break;
      }
      var tag = el.tagName.toLowerCase();
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === el.tagName;
        });
        if (same.length > 1) tag += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(tag);
      el = parent;
    }
    return parts.join(' > ');
  }
  function setHover(el) {
    if (hoverEl) hoverEl.classList.remove('atoms-pick-hover');
    hoverEl = el;
    if (hoverEl) hoverEl.classList.add('atoms-pick-hover');
  }
  function stopPick() {
    picking = false;
    setHover(null);
    document.documentElement.classList.remove('atoms-pick-on');
  }
  document.addEventListener(
    'mouseover',
    function (e) {
      if (picking && e.target !== document.documentElement && e.target !== document.body) setHover(e.target);
    },
    true,
  );
  document.addEventListener(
    'click',
    function (e) {
      if (!picking) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var el = e.target;
      if (!el || el === document.documentElement || el === document.body) return;
      el.classList.remove('atoms-pick-hover');
      var html = el.outerHTML.replace(/\s+/g, ' ');
      post({
        type: 'picked',
        target: {
          selector: cssPath(el),
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || '').trim().slice(0, 120),
          html: html.length > 800 ? html.slice(0, 800) + '…' : html,
        },
      });
      stopPick();
    },
    true,
  );
  document.addEventListener('keydown', function (e) {
    if (picking && e.key === 'Escape') {
      stopPick();
      post({ type: 'pick-cancelled' });
    }
  });

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.__atoms !== INIT.channel) return;
    if (m.type === 'pick') {
      if (m.on) {
        ensurePickStyle();
        picking = true;
        document.documentElement.classList.add('atoms-pick-on');
      } else stopPick();
    }
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
