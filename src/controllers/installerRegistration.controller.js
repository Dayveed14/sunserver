import { asyncHandler, HttpError } from '../lib/httpError.js';
import { installerRegistrationService as svc } from '../services/index.js';
import { numId } from '../utils/params.js';

export const overview = asyncHandler(async (req, res) => res.json(await svc.overview(req.user.id)));
export const save = asyncHandler(async (req, res) => res.json(await svc.save(req.user.id, req.valid)));
export const saveReferences = asyncHandler(async (req, res) => res.json(await svc.saveReferences(req.user.id, req.valid.references)));
export const submit = asyncHandler(async (req, res) => res.json(await svc.submit(req.user.id)));

// The file is the raw request body; its kind and label come in the query string.
export const uploadDocument = asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'INVALID_DOCUMENT', 'Upload a picture or PDF.');
  res.status(201).json(await svc.uploadDocument(req.user.id, {
    body: req.body, kind: String(req.query.kind ?? ''), label: typeof req.query.label === 'string' ? req.query.label : null,
  }));
});
export const deleteDocument = asyncHandler(async (req, res) => {
  await svc.deleteDocument(req.user.id, numId(req.params.id));
  res.status(204).end();
});
