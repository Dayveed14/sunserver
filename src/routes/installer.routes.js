import { Router } from 'express';
import * as v from '../controllers/verification.controller.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireVerifiedInstaller } from '../middleware/installerGate.js';
import * as j from '../controllers/installations.controller.js';
import { acceptJobSchema } from '../validators/installations.schemas.js';
import { quizSchema } from '../validators/verification.schemas.js';

// Mounted at /api/installer: what an installer does for themselves.
const router = Router();
router.use(authenticate, requireRole('installer'));

router.get('/summary', v.installerSummary);
router.get('/quiz', v.quiz);
router.post('/quiz', validate(quizSchema), v.submitQuiz);

// Jobs: only for installers the admin has approved.
router.use(requireVerifiedInstaller);
router.get('/jobs', j.openJobs);
router.get('/jobs/mine', j.myJobs);
router.get('/jobs/:ref', j.job);
router.post('/jobs/:ref/accept', validate(acceptJobSchema), j.accept);
router.post('/jobs/:ref/decline', j.decline);
router.post('/jobs/:ref/done', j.done);

export default router;
