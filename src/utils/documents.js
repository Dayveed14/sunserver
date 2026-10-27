import { sniffImage } from './images.js';

// Verification documents: pictures (a phone photo of a certificate) or PDFs. The type comes from the first bytes, never the name.
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const DOCUMENT_KINDS = ['cac', 'tax', 'id', 'shop', 'other'];

export function sniffDocument(buf) {
  if (Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return sniffImage(buf);
}

// What each kind of vendor must send before they can be reviewed.
export const requiredKinds = (vendorType) => (vendorType === 'company' ? ['cac'] : []);
