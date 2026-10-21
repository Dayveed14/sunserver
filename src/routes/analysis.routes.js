import { Router } from 'express';
import * as c from '../controllers/analysis.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { estimateLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { estimateSchema } from '../validators/analysis.schemas.js';

// Mounted at /api/analysis: the free solar assessment.
const router = Router();
const customers = [authenticate, requireRole('individual', 'business')];

router.get('/catalog/:segment', c.catalog);
router.post('/estimate', estimateLimiter, validate(estimateSchema), c.estimate);

router.post('/assessments', ...customers, validate(estimateSchema), c.saveAssessment);
router.get('/assessments', ...customers, c.listAssessments);
router.get('/assessments/:id', ...customers, c.getAssessment);

export default router;
