import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkParagraph,
  createChunks,
  decodeUtf8,
  normalizeExtractedText,
  paragraphsFromText,
  titleFromFilename,
} from '../server/text.mjs';
import { extractDocument } from '../server/extract.mjs';
import { citationFor } from '../server/citations.mjs';
import { documentIdFor, chunkIdFor } from '../server/store.mjs';

test('CRLF 归一化与空段忽略', () => {
  assert.equal(normalizeExtractedText(' 第一段 \r\n\r\n\r\n第二段\r'), '第一段\n\n第二段');
  const source = '第一段\n\n第二段\n\n\n第三段';
  const paragraphs = paragraphsFromText(source);
  assert.deepEqual(paragraphs.map((item) => item.text), ['第一段', '第二段', '第三段']);
  paragraphs.forEach((paragraph) => assert.equal(source.slice(paragraph.start, paragraph.end), paragraph.text));
});

test('长段落连续切片且不丢失原文', () => {
  const source = `开头。\n\n${'这是需要完整保留的长段落。'.repeat(200)}`;
  const paragraphs = paragraphsFromText(source);
  const chunks = createChunks(paragraphs);
  assert.ok(chunks.length > 5);
  assert.deepEqual(chunks.map((item) => item.chunkIndex), chunks.map((_, index) => index + 1));
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 420);
    assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
    assert.equal(source.slice(chunk.paragraphStart, chunk.paragraphEnd), paragraphs[chunk.paragraphIndex - 1].text);
  }
  const longChunks = chunks.filter((item) => item.paragraphIndex === 2);
  assert.ok(longChunks.every((item) => item.paragraphStart === longChunks[0].paragraphStart));
  assert.equal(longChunks.at(-1).end, paragraphs[1].end);
});

test('切片优先保留句子边界', () => {
  const source = `${'甲'.repeat(100)}。${'乙'.repeat(100)}。${'丙'.repeat(100)}。`;
  const [paragraph] = paragraphsFromText(source);
  const chunks = chunkParagraph(paragraph, 1, 120);
  assert.equal(chunks[0].text.at(-1), '。');
  assert.equal(chunks.map((item) => item.text).join(''), source);
});

test('严格 UTF-8 解码与文件错误', async () => {
  assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad])), '中');
  assert.throws(() => decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd])), /UTF-8/);
  await assert.rejects(() => extractDocument({ originalname: 'bad.exe', buffer: Buffer.from('x') }), /仅支持/);
  await assert.rejects(() => extractDocument({ originalname: 'empty.txt', buffer: Buffer.alloc(0) }), /文件为空/);
  await assert.rejects(() => extractDocument({ originalname: 'blank.md', buffer: Buffer.from(' \n\n') }), /未提取到文字/);
});

test('文档与片段 ID 稳定且资料库隔离', () => {
  const hash = 'a'.repeat(64);
  const first = documentIdFor('1'.repeat(32), hash);
  const second = documentIdFor('2'.repeat(32), hash);
  assert.equal(first, documentIdFor('1'.repeat(32), hash));
  assert.notEqual(first, second);
  assert.equal(chunkIdFor(first, 2), `${first}:2`);
});

test('引用包含逐字原文和稳定定位', () => {
  const item = {
    id: 'a'.repeat(32) + ':2',
    text: '<script>原文</script>',
    title: '转义样例',
    filename: 'escape.md',
    pageNumber: 2,
    paragraphIndex: 3,
    chunkIndex: 2,
  };
  const citation = citationFor(item);
  assert.match(citation, /<script>原文<\/script>/);
  assert.match(citation, /第 2 页/);
  assert.match(citation, /稳定片段 ID/);
  assert.equal(titleFromFilename('课程.notes.md'), '课程.notes');
});
