import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

function drawLines(page, font, lines) {
  lines.forEach((line, index) => page.drawText(line, {
    x: 54,
    y: 770 - index * 22,
    size: 11,
    font,
    color: rgb(0.12, 0.12, 0.12),
  }));
}

export async function twoPagePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  drawLines(pdf.addPage([612, 792]), font, [
    'PaperTrail self-authored PDF fixture - page one',
    'This introduction deliberately avoids the query term used by acceptance tests.',
    'The fixture is generated for this project and is not a published paper.',
  ]);
  drawLines(pdf.addPage([612, 792]), font, [
    'PaperTrail self-authored PDF fixture - page two',
    'retrieval evidence begins on the second page.',
    'longparagraphanchor supports chunk location verification.',
    ...Array.from({ length: 18 }, (_, index) => `Sentence ${index + 1}: original context must remain available for every reader checking a citation.`),
  ]);
  return Buffer.from(await pdf.save());
}

export async function noTextPdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}
