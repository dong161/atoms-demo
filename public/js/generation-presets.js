export const THEMES = [
  { id: 'default', name: '自由创作', primary: '#6d5efc', bg: '#faf9ff', text: '#252136', radius: '12px', font: 'system-ui, sans-serif' },
  { id: 'zen', name: '静谧自然', primary: '#4d634f', bg: '#f4f3eb', text: '#292e28', radius: '16px', font: 'system-ui, sans-serif' },
  { id: 'clay', name: '陶土暖色', primary: '#b9532c', bg: '#fff7ee', text: '#402c25', radius: '18px', font: 'Georgia, serif' },
  { id: 'notion', name: '极简黑白', primary: '#292929', bg: '#ffffff', text: '#202020', radius: '6px', font: 'system-ui, sans-serif' },
  { id: 'ocean', name: '清透蓝色', primary: '#2463eb', bg: '#f0f7ff', text: '#18314d', radius: '12px', font: 'system-ui, sans-serif' },
];
// 附件会随每一路模型请求发送；按最小上下文的候选模型（约 128K tokens）留出当前代码和输出的空间
export const FILE_LIMITS = { count: 3, chars: 30000, totalChars: 60000, bytes: 100_000, totalBytes: 200_000 };
export function validateAttachments(files) {
  if (!Array.isArray(files) || files.length > FILE_LIMITS.count) throw new Error('最多添加3个文本附件');
  let chars = 0,
    bytes = 0;
  return files.map((file) => {
    if (!file || typeof file.name !== 'string' || typeof file.text !== 'string') throw new Error('附件格式不正确');
    const name = file.name.trim();
    const text = file.text;
    if (!name || name.length > 128 || !/\.(txt|md|json|csv)$/i.test(name) || /[\x00-\x1f]/.test(name))
      throw new Error('仅支持 TXT、Markdown、JSON、CSV 文本文件');
    const size = new TextEncoder().encode(text).length;
    chars += text.length;
    bytes += size;
    if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text)) throw new Error('附件为空或不是有效UTF-8文本');
    if (text.length > FILE_LIMITS.chars || size > FILE_LIMITS.bytes || chars > FILE_LIMITS.totalChars || bytes > FILE_LIMITS.totalBytes)
      throw new Error('单个附件最多 3 万字符（约 100KB），合计最多 6 万字符（约 200KB）');
    return { name, text };
  });
}
