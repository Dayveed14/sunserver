import express, { Router } from 'express';
import * as c from '../controllers/audits.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { auditUploadLimiter, orderActionLimiter, requestLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { MAX_IMAGE_BYTES } from '../utils/images.js';
import { assignSchema, createAgentSchema, formBodySchema, reopenSchema, requestAuditSchema } from '../validators/audits.schemas.js';

const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMAGE_BYTES });

// Mounted at /api/audits: a business asks for a site assessment and follows it.
export const businessRouter = Router();
businessRouter.use(authenticate, requireRole('business'));
businessRouter.get('/', c.listMine);
businessRouter.post('/', requestLimiter, validate(requestAuditSchema), c.request);
businessRouter.get('/:ref', c.getMine);

// Mounted at /api/agent: a field agent's jobs, survey form and photos.
export const agentRouter = Router();
agentRouter.use(authenticate, requireRole('field_agent'));
agentRouter.get('/catalog', c.catalog);
agentRouter.get('/jobs', c.jobs);
agentRouter.get('/jobs/:ref', c.job);
agentRouter.post('/jobs/:ref/start', orderActionLimiter, c.start);
agentRouter.put('/jobs/:ref/draft', orderActionLimiter, validate(formBodySchema), c.saveDraft);
agentRouter.post('/jobs/:ref/preview', orderActionLimiter, validate(formBodySchema), c.preview);
agentRouter.post('/jobs/:ref/photos/:slot', auditUploadLimiter, rawImage, c.uploadPhoto);
agentRouter.post('/jobs/:ref/submit', orderActionLimiter, validate(formBodySchema), c.submit);

// Mounted at /api/admin/audits: the admin's queue, assigning agents, and reopening a result.
export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('admin'));
adminRouter.get('/', c.adminList);
adminRouter.get('/:ref', c.adminGet);
adminRouter.post('/:ref/assign', validate(assignSchema), c.assign);
adminRouter.post('/:ref/reopen', validate(reopenSchema), c.reopen);

// Mounted at /api/admin/field-agents.
export const adminAgentsRouter = Router();
adminAgentsRouter.use(authenticate, requireRole('admin'));
adminAgentsRouter.get('/', c.agents);
adminAgentsRouter.post('/', validate(createAgentSchema), c.createAgent);

// Mounted at /api/audit-photos: opens a private site picture for the people allowed to see it.
export const photoRouter = Router();
photoRouter.get('/:id', authenticate, requireRole('business', 'field_agent', 'admin'), c.photo);
