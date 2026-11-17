import { BRIEF_DOCUMENT_MAX_FILE_BYTES, KNOWLEDGE_MAX_FILE_BYTES } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { PHOTO_MAX_RAW_BYTES, pickedFileLimit } from './upload-limits';

/* QA bug list, 17 Nov: "A large phone photo is refused as larger than 10 MB before it is shrunk". */
describe('pickedFileLimit', () => {
  const MB = 1024 * 1024;

  it('a photo is not held to the upload limit as picked: a 12 MB phone shot passes on W2', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(pickedFileLimit(type, BRIEF_DOCUMENT_MAX_FILE_BYTES), type).toBe(PHOTO_MAX_RAW_BYTES);
      expect(12 * MB <= pickedFileLimit(type, BRIEF_DOCUMENT_MAX_FILE_BYTES), type).toBe(true);
      expect(25 * MB <= pickedFileLimit(type, KNOWLEDGE_MAX_FILE_BYTES), type).toBe(true);
    }
  });

  it('a photo still has a ceiling', () => {
    expect(PHOTO_MAX_RAW_BYTES).toBe(50 * MB);
    expect(51 * MB <= pickedFileLimit('image/jpeg', BRIEF_DOCUMENT_MAX_FILE_BYTES)).toBe(false);
  });

  it('a document keeps the limit of the form it is picked in', () => {
    for (const type of ['application/pdf', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
      expect(pickedFileLimit(type, BRIEF_DOCUMENT_MAX_FILE_BYTES), type).toBe(10 * MB);
      expect(pickedFileLimit(type, KNOWLEDGE_MAX_FILE_BYTES), type).toBe(20 * MB);
    }
  });

  it('never lowers a limit that is already above the photo ceiling', () => {
    expect(pickedFileLimit('image/jpeg', 80 * MB)).toBe(80 * MB);
  });
});
