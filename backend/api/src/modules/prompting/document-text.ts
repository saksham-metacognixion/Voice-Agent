import { BRIEF_DOCUMENTS_MAX_CHARS, type BriefDocumentType } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';

/**
 * W2 documents (ADR 0023): a file → the plain text the brief keeps.
 *
 * Two libraries do the reading and nothing here is stored: PDF through `unpdf` (pdf.js
 * without a canvas, so it runs in the API's CommonJS build with no native module) and
 * Word through `mammoth`'s raw-text mode, which drops every style and keeps every word.
 * A text, Markdown or CSV file is UTF-8 already. Both readers are loaded on first use —
 * pdf.js is ~2 MB of parser the API does not need to load to boot.
 *
 * What comes out is normalised so a menu laid out in columns reads as lines: runs of
 * spaces collapse, blank lines are kept to one, and the whole thing is cut to the brief's
 * budget with `truncated` set — the customer sees that on W2 and can trim the file.
 */
export interface ExtractedText {
  text: string;
  /** Characters in the whole file before the cut. */
  chars: number;
  truncated: boolean;
}

export async function extractDocumentText(
  bytes: Buffer,
  contentType: BriefDocumentType,
  budget = BRIEF_DOCUMENTS_MAX_CHARS,
): Promise<ExtractedText> {
  return finishText(await readText(bytes, contentType), budget);
}

/** Normalise and cut to the budget. The last step for a file's text and for a transcribed photo alike. */
export function finishText(raw: string, budget = BRIEF_DOCUMENTS_MAX_CHARS): ExtractedText {
  const text = normalise(raw);
  if (!text) {
    throw new AppError(
      'DOCUMENT_UNREADABLE',
      'We could not find any text in that file. A scanned image needs to be typed out or exported as text first.',
      [{ field: 'content_base64', message: 'No text found' }],
    );
  }
  if (text.length <= budget) return { text, chars: text.length, truncated: false };
  return { text: cutAtLine(text, budget), chars: text.length, truncated: true };
}

async function readText(bytes: Buffer, contentType: BriefDocumentType): Promise<string> {
  try {
    switch (contentType) {
      case 'application/pdf': {
        const { extractText } = await import('unpdf');
        const result = await extractText(new Uint8Array(bytes), { mergePages: true });
        return Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
      }
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: bytes });
        return result.value;
      }
      default:
        return bytes.toString('utf8');
    }
  } catch (error) {
    throw new AppError(
      'DOCUMENT_UNREADABLE',
      'We could not read that file. Try exporting it again, or paste the text instead.',
      [
        {
          field: 'content_base64',
          message: error instanceof Error ? error.message.slice(0, 200) : 'Unreadable file',
        },
      ],
    );
  }
}

/** Written as code points, not escapes, so a formatter cannot turn them into invisible literals. */
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);

/** Collapse the whitespace a layout engine leaves behind; keep paragraph breaks. */
export function normalise(raw: string): string {
  return raw
    .split(BOM)
    .join('')
    .split(NUL)
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cut to the budget at the last line break before it, so no line is left half-read. */
function cutAtLine(text: string, budget: number): string {
  const head = text.slice(0, budget);
  const lastBreak = head.lastIndexOf('\n');
  return (lastBreak > budget * 0.8 ? head.slice(0, lastBreak) : head).trimEnd();
}
