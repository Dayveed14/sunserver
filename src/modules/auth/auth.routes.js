import { Router } from 'express';
import { asyncHandler } from '../../lib/httpError.js';
import { clearSessionCookie, setSessionCookie } from '../../lib/tokens.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter, otpLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { usersRepo } from '../../repos/users.js';
import { publicGeo } from '../geo/areas.js';
import { authService } from './index.js';
import { addAccountSchema, forgotSchema, loginSchema, profileSchema, registerSchema, resendSchema, resetSchema, switchSchema, verifySchema } from './auth.schemas.js';

const router = Router();

// 1) Sign up -> an OTP is emailed. No session yet.
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { userId, ...result } = await authService.register(req.valid);
    // Adding another account type to an email they already own needs no code: sign them straight in.
    if (result.added) setSessionCookie(res, await usersRepo.findById(userId));
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

router.post(
  '/forgot-password',
  otpLimiter,
  validate(forgotSchema),
  asyncHandler(async (req, res) => res.json(await authService.forgotPassword(req.valid)))
);

router.post(
  '/reset-password',
  otpLimiter,
  validate(resetSchema),
  asyncHandler(async (req, res) => res.json(await authService.resetPassword(req.valid)))
);

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const accounts = (await usersRepo.listByEmail(req.user.email))
    .filter((u) => u.email_verified_at && u.status === 'active' && u.role !== 'admin')
    .map((u) => ({ role: u.role, companyName: u.company_name ?? null, current: Number(u.id) === req.user.id }));
  res.json({ user: req.user, accounts });
}));

router.post('/switch', authenticate, validate(switchSchema), asyncHandler(async (req, res) => {
  const user = await authService.switchAccount(req.user.id, req.valid.role);
  setSessionCookie(res, await usersRepo.findById(user.id));
  res.json({ user });
}));

router.post('/accounts', authenticate, authLimiter, validate(addAccountSchema), asyncHandler(async (req, res) => {
  const user = await authService.addAccount(req.user.id, req.valid);
  setSessionCookie(res, await usersRepo.findById(user.id));
  res.status(201).json({ user });
}));

router.put('/profile', authenticate, validate(profileSchema), asyncHandler(async (req, res) => {
  res.json({ user: await authService.updateProfile(req.user.id, req.valid) });
}));

router.get('/areas', (req, res) => res.json(publicGeo()));

export default router;
