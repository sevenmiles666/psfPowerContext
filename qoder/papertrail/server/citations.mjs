export function locationLabel(item) {
  const parts = [];
  if (item.pageNumber) parts.push(`第 ${item.pageNumber} 页`);
  parts.push(`第 ${item.paragraphIndex} 段`, `片段 ${item.chunkIndex}`);
  return parts.join(' · ');
}

export function citationFor(item) {
  return `“${item.text}”\n—— ${item.title}（${item.filename}），${locationLabel(item)}，稳定片段 ID：${item.id}`;
}

export function unpackCollection(result) {
  const grouped = Array.isArray(result.ids?.[0]);
  const flat = (key) => (grouped ? result[key]?.[0] : result[key]);
  return (flat('ids') || []).map((id, index) => {
    const metadata = flat('metadatas')?.[index] || {};
    const item = {
      id,
      text: flat('documents')?.[index] || '',
      documentId: metadata.documentId,
      libraryId: metadata.libraryId,
      title: metadata.title,
      filename: metadata.filename,
      kind: metadata.kind,
      pageNumber: metadata.pageNumber || null,
      paragraphIndex: metadata.paragraphIndex,
      chunkIndex: metadata.chunkIndex,
      sourceStart: metadata.sourceStart,
      sourceEnd: metadata.sourceEnd,
      paragraphStart: metadata.paragraphStart,
      paragraphEnd: metadata.paragraphEnd,
      distance: flat('distances')?.[index] ?? null,
    };
    return { ...item, location: locationLabel(item), citation: citationFor(item) };
  });
}
