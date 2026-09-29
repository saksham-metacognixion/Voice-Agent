import { describe, expect, it } from 'vitest';
import { extractDocumentText, normalise } from './document-text';

/*
 * W2 documents (ADR 0023). The PDF and the Word file are built here rather than checked in
 * as fixtures: the point is that the real readers run in the API's CommonJS build, not
 * that one particular file parses.
 */

/** A one-page PDF with the given lines, uncompressed, hand-written to the spec. */
function tinyPdf(lines: string[]): Buffer {
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '14 TL',
    ...lines.map((line) => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** The smallest .docx Word would open: one document part with the given paragraphs. */
async function tinyDocx(paragraphs: string[]): Promise<Buffer> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractDocumentText', () => {
  it('reads a PDF menu into lines', async () => {
    const pdf = tinyPdf(['Margherita pizza $14', 'Caesar salad $9', 'Tiramisu $7']);
    const out = await extractDocumentText(pdf, 'application/pdf');
    expect(out.text).toContain('Margherita pizza $14');
    expect(out.text).toContain('Tiramisu $7');
    expect(out.truncated).toBe(false);
    expect(out.chars).toBe(out.text.length);
  });

  it('reads a Word price list', async () => {
    const docx = await tinyDocx(['Check-up and cleaning $150', 'Emergency visit $95']);
    const out = await extractDocumentText(
      docx,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(out.text).toBe('Check-up and cleaning $150\n\nEmergency visit $95');
  });

  it('passes plain text through, normalised', async () => {
    const out = await extractDocumentText(
      Buffer.from(String.fromCharCode(0xfeff) + 'Hours:\t  Mon-Fri\r\n\r\n\r\n\r\n9-5   \n'),
      'text/plain',
    );
    expect(out.text).toBe('Hours: Mon-Fri\n\n9-5');
  });

  it('cuts to the budget at a line break and says so', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Item ${i} costs $${i}`);
    const out = await extractDocumentText(Buffer.from(lines.join('\n')), 'text/plain', 500);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(500);
    expect(out.text.endsWith('\n')).toBe(false);
    // Whole lines only: the last line present is complete.
    expect(out.text.split('\n').pop()).toMatch(/^Item \d+ costs \$\d+$/);
    expect(out.chars).toBe(lines.join('\n').length);
  });

  it('refuses a file with no text as DOCUMENT_UNREADABLE', async () => {
    await expect(extractDocumentText(Buffer.from('   \n\n '), 'text/plain')).rejects.toMatchObject({
      code: 'DOCUMENT_UNREADABLE',
    });
  });

  it('refuses a broken PDF as DOCUMENT_UNREADABLE, not a 500', async () => {
    await expect(
      extractDocumentText(Buffer.from('%PDF-1.4 not really'), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'DOCUMENT_UNREADABLE' });
  });

  it('normalise strips NUL bytes Postgres would refuse', () => {
    expect(normalise(`a${String.fromCharCode(0)}b`)).toBe('ab');
  });
});
