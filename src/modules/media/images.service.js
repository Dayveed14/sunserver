import { HttpError } from '../../lib/httpError.js';
import { MAX_IMAGE_BYTES, imageUrl, sniffImage } from './images.js';

// Checks an uploaded picture and stores it: on Cloudinary when it is configured, otherwise in the database.
export function createImageService({ imagesRepo, cloudinary }) {
  return {
    storage: cloudinary.enabled ? 'cloudinary' : 'database',

    async store(ownerId, body) {
      const mime = sniffImage(body);
      if (!mime) throw new HttpError(400, 'INVALID_IMAGE', 'Upload a JPEG, PNG or WebP picture.');
      if (body.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'That picture is too large.');
      let remote = null;
      if (cloudinary.enabled) {
        try {
          remote = await cloudinary.upload(body, mime);
        } catch (err) {
          console.error('[images] Cloudinary upload failed:', err.message);
          throw new HttpError(502, 'UPLOAD_FAILED', 'We could not save that picture. Please try again.');
        }
      }
      const id = await imagesRepo.create({ ownerId, mime, size: body.length, data: remote ? null : body, remote });
      return { id, url: imageUrl(id) };
    },
  };
}
