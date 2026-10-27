import { Router } from 'express';
import * as c from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter, otpLimiter } from '../middleware/rateLimits.js';
import { validate } from '../middleware/validate.js';
import { addAccountSchema, changePasswordSchema, forgotSchema, loginSchema, profileSchema, registerSchema, resendSchema, resetSchema, switchSchema, verifySchema } from '../validators/auth.schemas.js';

// Mounted at /api/auth.  Each line: URL -> middleware (limits, checks) -> controller.
const router = Router();

router.post('/register', authLimiter, validate(registerSchema), c.register);
router.post('/verify-otp', otpLimiter, validate(verifySchema), c.verifyOtp);
router.post('/resend-otp', otpLimiter, validate(resendSchema), c.resendOtp);
router.post('/login', authLimiter, validate(loginSchema), c.login);
router.post('/forgot-password', otpLimiter, validate(forgotSchema), c.forgotPassword);
router.post('/reset-password', otpLimiter, validate(resetSchema), c.resetPassword);
router.post('/logout', c.logout);

router.get('/me', authenticate, c.me);
router.post('/switch', authenticate, validate(switchSchema), c.switchAccount);
router.post('/accounts', authenticate, authLimiter, validate(addAccountSchema), c.addAccount);
router.post('/change-password', authenticate, authLimiter, validate(changePasswordSchema), c.changePassword);
router.put('/profile', authenticate, validate(profileSchema), c.updateProfile);
router.get('/areas', c.areas);

export default router;
