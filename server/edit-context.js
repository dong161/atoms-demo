// 修改时的附加上下文：预览里点选的元素、预览控制台报错。
// 只拼进发给模型的指令，不出现在对话消息和验收清单里。

const clip = (s, n) => String(s ?? '').slice(0, n);

/** 校验点选元素：{ selector, tag, text, html }，返回清洗后的对象或 null。 */
export function parseTarget(input) {
  if (!input || typeof input !== 'object') return null;
  const selector = clip(input.selector, 300).trim();
  const tag = clip(input.tag, 20)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (!selector || !tag) return null;
  return { selector, tag, text: clip(input.text, 120).trim(), html: clip(input.html, 800) };
}

/** 校验控制台报错列表：最多 5 条，每条 ≤300 字。 */
export function parseErrors(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((e) => clip(e, 300).trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** 生成追加给模型的说明文字。 */
export function editHint({ target, errors }) {
  const parts = [];
  if (target) {
    parts.push(
      `【只修改用户在预览中选中的这个元素】\n选择器：${target.selector}\n标签：<${target.tag}>${target.text ? `\n文字：${target.text}` : ''}\n元素片段：${target.html}\n页面其它部分、功能和数据结构保持不变。`,
    );
  }
  if (errors.length) {
    parts.push(
      `【预览运行时出现以下报错，请定位原因并修复，修复后不能再报错，其它功能保持不变】\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`,
    );
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}
