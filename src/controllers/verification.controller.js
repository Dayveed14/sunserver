import { asyncHandler, HttpError } from '../lib/httpError.js';
import { optimisedUrl } from '../lib/cloudinary.js';
import { verificationService as svc } from '../services/index.js';
import { DOCUMENT_KINDS } from '../utils/documents.js';
import { numId } from '../utils/params.js';

// ---- vendor ----
export const vendorStatus = asyncHandler(async (req, res) => res.json(await svc.vendorStatus(req.user.id)));

// The file is the raw request body; its kind and label come in the query string.
export const uploadDocument = asyncHandler(async (req, res) => {
  const kind = String(req.query.kind ?? '');
  if (!DOCUMENT_KINDS.includes(kind)) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose what kind of document this is.');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'INVALID_DOCUMENT', 'Upload a PDF, JPEG, PNG or WebP file.');
  res.status(201).json(await svc.uploadDocument(req.user.id, { body: req.body, kind, label: typeof req.query.label === 'string' ? req.query.label : null }));
});
export const deleteDocument = asyncHandler(async (req, res) => {
  await svc.deleteDocument(req.user.id, numId(req.params.id));
  res.status(204).end();
});
export const submit = asyncHandler(async (req, res) => res.json(await svc.submit(req.user.id)));

// Owner or admin only. Never cached by shared caches.
export const documentFile = asyncHandler(async (req, res) => {
  const f = await svc.documentFile(req.user, numId(req.params.id));
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  if (f.remoteUrl) return res.redirect(302, f.mime === 'application/pdf' ? f.remoteUrl : optimisedUrl(f.remoteUrl, 'f_auto,q_auto,w_1600,c_limit'));
  res.set('Content-Type', f.mime);
  res.send(f.data);
});

// ---- admin ----
export const vendorReview = asyncHandler(async (req, res) => res.json(await svc.vendorReview(numId(req.params.id))));
export const decideVendor = asyncHandler(async (req, res) => res.json(await svc.decideVendor(req.user.id, numId(req.params.id), req.valid)));
export const listInstallers = asyncHandler(async (req, res) => {
  const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
  res.json(await svc.listInstallers({ status }));
});
export const installerReview = asyncHandler(async (req, res) => res.json(await svc.installerReview(numId(req.params.id))));
export const decideInstaller = asyncHandler(async (req, res) => res.json(await svc.decideInstaller(req.user.id, numId(req.params.id), req.valid)));

// ---- installer ----
export const installerSummary = asyncHandler(async (req, res) => res.json(await svc.installerSummary(req.user.id)));
export const quiz = asyncHandler(async (req, res) => res.json(await svc.quiz(req.user.id)));
export const submitQuiz = asyncHandler(async (req, res) => res.json(await svc.submitQuiz(req.user.id, req.valid)));
