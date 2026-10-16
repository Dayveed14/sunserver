import { Router } from 'express';
import { asyncHandler } from '../../lib/httpError.js';
import { clearSessionCookie, setSessionCookie } from '../../lib/tokens.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter, otpLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { usersRepo } from '../../repos/users.js';
import { authService } from './index.js';
import { loginSchema, registerSchema, resendSchema, verifySchema } from './auth.schemas.js';

const router = Router();

// 1) Sign up -> an OTP is emailed. No session yet.
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.valid);
    res.status(201).json(result);
  })
);

// 2) Verify the OTP -> account is verified and the user is logged in.
router.post(
  '/verify-otp',
  otpLimiter,
  validate(verifySchema),
  asyncHandler(async (req, res) => {
    const user = await authService.verifyEmail(req.valid);
    const full = await usersRepo.findById(user.id);
    setSessionCookie(res, full);
    res.json({ user });
  })
);

router.post(
  '/resend-otp',
  otpLimiter,
  validate(resendSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.resendOtp(req.valid);
    res.json(result);
  })
);

// Logging in never needs an OTP; the OTP is only for proving ownership of the email at sign-up.
router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const user = await authService.login(req.valid);
    const full = await usersRepo.findById(user.id);
    setSessionCookie(res, full);
    res.json({ user });
  })
);

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

export default router;
