import { extractAgentDocument } from '@portal/api-client';
import { BRIEF_DOCUMENT_IMAGE_TYPES, type BriefDocumentImageType, isImageDocumentType } from '@portal/schemas';

/**
 * A photo — a menu on the table, a price board — read into text. The platform's knowledge
 * base ingests documents, not images, so W2's documents, the menu slot and the "Add a
 * source" form all send a photo through `POST /agents/:id/documents/extract` (the
 * generation model's vision, ADR 0023) and keep the text it answers with.
 */

export const PHOTO_TYPES = BRIEF_DOCUMENT_IMAGE_TYPES;
export const isPhoto = (type: string): type is BriefDocumentImageType => isImageDocumentType(type);

const PHOTO_MAX_EDGE = 2000;
const PHOTO_QUALITY = 0.85;

type Api = Parameters<typeof extractAgentDocument>[0];

/** The photo's text and a name for it (the file name without its extension). */
export async function photoToText(api: Api, agentId: string, file: File): Promise<{ name: string; text: string; truncated: boolean }> {
  const upload = await shrinkPhoto(file);
  const name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 120) || 'Photo';
  const result = await extractAgentDocument(api, { id: agentId }, { name, content_type: (upload.type || file.type) as BriefDocumentImageType, content_base64: await toBase64(upload) });
  return { name: result.name, text: result.text, truncated: result.truncated };
}

/**
 * Re-encode a photo as a JPEG no larger than PHOTO_MAX_EDGE on its long side. The
 * browser applies the EXIF orientation when it decodes, so a sideways phone shot comes
 * out upright. A PNG with transparency is flattened onto white — a menu has no alpha
 * worth keeping. If the browser cannot decode it, the original goes up as it is.
 */
export async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === 'image/jpeg' && file.size < 2 * 1024 * 1024) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
    return blob ?? file;
  } catch {
    return file;
  }
}

export function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
