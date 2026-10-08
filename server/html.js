// 模型输出 → 可运行 HTML 的清洗与静态检查。

/** 从模型输出中取出 HTML 文档：去掉 ```html 围栏和前后说明文字。 */
export function extractHtml(raw) {
  if (!raw) return '';
  let text = String(raw);
  const fence = text.match(/```(?:html|HTML)?\s*\n([\s\S]*?)(?:```|$)/);
  if (fence && /<html|<!doctype|<body|<div/i.test(fence[1])) text = fence[1];
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) text = text.slice(start);
  const end = text.search(/<\/html>/i);
  if (end >= 0) text = text.slice(0, end + '</html>'.length);
  text = text.trim();
  if (!/<html[\s>]/i.test(text) && /<(div|body|main|section|style|script)[\s>]/i.test(text)) {
    text = `<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body>\n${text}\n</body>\n</html>`;
  }
  return text;
}

/** 生成结果的静态完整性检查，返回 0-10 分和问题列表。 */
export function staticCheck(html) {
  const issues = [];
  let score = 10;
  if (!/<!doctype html>/i.test(html)) {
    score -= 1;
    issues.push('缺少 <!DOCTYPE html>');
  }
  if (!/<\/html>\s*$/i.test(html)) {
    score -= 3;
    issues.push('文档不完整（可能输出被截断）');
  }
  if (!/<title>[^<]+<\/title>/i.test(html)) {
    score -= 1;
    issues.push('缺少标题');
  }
  if (!/name=["']viewport["']/i.test(html)) {
    score -= 2;
    issues.push('缺少 viewport，移动端会缩放');
  }
  if (!/<script[\s>]/i.test(html)) {
    score -= 3;
    issues.push('没有脚本，可能只是静态页面');
  }
  if (html.length < 1500) {
    score -= 2;
    issues.push('内容过少');
  }
  return { score: Math.max(0, score), issues };
}

/** 给版本起一个短标题：优先 <title>。 */
export function titleFromHtml(html, fallback = '未命名应用') {
  const m = html.match(/<title>([^<]{1,60})<\/title>/i);
  return (m ? m[1] : fallback).trim() || fallback;
}
