export function downloadText(filename, content, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('浏览器未允许剪贴板访问，请使用导出功能。');
}

export function resultsMarkdown(title, items, metadata = {}) {
  const lines = [`# ${title}`, '', `导出时间：${new Date().toISOString()}`];
  if (metadata.query) lines.push(`查询：${metadata.query}`, `模式：${metadata.mode}`, `检索记录：${metadata.traceId}`);
  lines.push('', `共 ${items.length} 个片段。以下均为导入资料的逐字原文。`, '');
  for (const [index, item] of items.entries()) {
    lines.push(`## ${index + 1}. ${item.title}`, '', `- 文件：${item.filename}`, `- 定位：${item.location}`, `- 稳定片段 ID：${item.id}`, '', `> ${item.text.replaceAll('\n', '\n> ')}`, '');
  }
  return lines.join('\n');
}

export const formatBytes = (bytes) => bytes < 1024 * 1024
  ? `${Math.ceil(bytes / 1024)} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
