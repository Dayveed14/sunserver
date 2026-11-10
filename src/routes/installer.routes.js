import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as v from '../controllers/verification.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireVerifiedInstaller } from '../middleware/installerGate.js';
import * as j from '../controllers/installations.controller.js';
import * as rp from '../controllers/repairs.controller.js';
import { completeSchema, partsNoteSchema, repairReportSchema, variationSchema } from '../validators/repairs.schemas.js';
import { MAX_IMAGE_BYTES } from '../utils/images.js';
import { acceptJobSchema, completeInstallSchema } from '../validators/installations.schemas.js';
import { quizSchema } from '../validators/verification.schemas.js';
import * as reg from '../controllers/installerRegistration.controller.js';
import { registrationPatchSchema, referencesSchema, submitRegistrationSchema } from '../validators/installerRegistration.schemas.js';
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from '../utils/documents.js';

// Mounted at /api/installer: what an installer does for themselves.
const router = Router();
router.use(authenticate, requireRole('installer'));

router.get('/summary', v.installerSummary);
router.get('/quiz', v.quiz);
router.post('/quiz', validate(quizSchema), v.submitQuiz);

// Registration: open to every installer, because it is how they get approved. Files are private to the installer and the admin.
const docLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many uploads. Please wait a few minutes.' } } });
router.get('/registration', reg.overview);
router.put('/registration', validate(registrationPatchSchema), reg.save);
router.put('/references', validate(referencesSchema), reg.saveReferences);
router.post('/registration/submit', validate(submitRegistrationSchema), reg.submit);
router.post('/documents', docLimiter, express.raw({ type: DOCUMENT_TYPES, limit: MAX_DOCUMENT_BYTES }), reg.uploadDocument);
router.get('/documents/:id/file', v.documentFile);
router.delete('/documents/:id', reg.deleteDocument);

// Jobs: only for installers the admin has approved.
router.use(requireVerifiedInstaller);
router.get('/jobs', j.openJobs);
router.get('/jobs/mine', j.myJobs);
router.get('/jobs/:ref', j.job);
router.post('/jobs/:ref/accept', validate(acceptJobSchema), j.accept);
router.post('/jobs/:ref/decline', j.decline);
router.post('/jobs/:ref/on-my-way', j.onMyWay);
router.post('/jobs/:ref/arrived', j.arrived);
router.post('/jobs/:ref/start', j.start);
router.post('/jobs/:ref/photos/:kind', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES }), j.addPhoto);
router.delete('/jobs/:ref/photos/:id', j.removePhoto);
router.get('/jobs/:ref/photos/:id', j.photo);
router.post('/jobs/:ref/complete', validate(completeInstallSchema), j.complete);

// Repairs: offers the admin approved for this technician, and the ones they have taken.
router.get('/repairs', rp.offers);
router.get('/repairs/mine', rp.myJobs);
router.get('/repairs/:ref', rp.job);
router.post('/repairs/:ref/accept', rp.accept);
router.post('/repairs/:ref/decline', rp.decline);
router.post('/repairs/:ref/on-my-way', rp.onMyWay);
router.post('/repairs/:ref/arrived', rp.arrived);
router.post('/repairs/:ref/photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES }), rp.techAddPhoto);
router.delete('/repairs/:ref/photos/:id', rp.techRemovePhoto);
router.get('/repairs/:ref/photos/:id', rp.photo);
router.post('/repairs/:ref/report', validate(repairReportSchema), rp.report);
router.post('/repairs/:ref/start', rp.startRepair);
router.post('/repairs/:ref/awaiting-parts', validate(partsNoteSchema), rp.awaitingParts);
router.post('/repairs/:ref/parts-arrived', rp.partsArrived);
router.post('/repairs/:ref/variations', validate(variationSchema), rp.proposeVariation);
router.post('/repairs/:ref/variations/:id/withdraw', rp.withdrawVariation);
router.post('/repairs/:ref/completion-photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES }), rp.completionAddPhoto);
router.delete('/repairs/:ref/completion-photos/:id', rp.completionRemovePhoto);
router.post('/repairs/:ref/complete', validate(completeSchema), rp.complete);

export default router;
