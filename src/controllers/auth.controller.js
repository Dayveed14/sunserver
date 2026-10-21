import { asyncHandler } from '../lib/httpError.js';
import { clearSessionCookie, setSessionCookie } from '../lib/tokens.js';
import { authService } from '../services/index.js';
import { publicGeo } from '../utils/areas.js';

// Controllers read the request, call ONE service method, and send the response. No business rules live here.

// 1) Sign up -> an OTP is emailed. No session yet.
export const register = asyncHandler(async (req, res) => {
  const { userId, ...result } = await authService.register(req.valid);
  // Adding another account type to an email they already own needs no code: sign them straight in.
  if (result.added) setSessionCookie(res, await authService.sessionUser(userId));
  res.status(201).json(result);
});

// 2) Verify the OTP -> account is verified and the user is logged in.
export const verifyOtp = asyncHandler(async (req, res) => {
  const user = await authService.verifyEmail(req.valid);
  setSessionCookie(res, await authService.sessionUser(user.id));
  res.json({ user });
});

export const resendOtp = asyncHandler(async (req, res) => res.json(await authService.resendOtp(req.valid)));

// Logging in never needs an OTP; the OTP is only for proving ownership of the email at sign-up.
export const login = asyncHandler(async (req, res) => {
  const user = await authService.login(req.valid);
  setSessionCookie(res, await authService.sessionUser(user.id));
  res.json({ user });
});

export const forgotPassword = asyncHandler(async (req, res) => res.json(await authService.forgotPassword(req.valid)));
export const resetPassword = asyncHandler(async (req, res) => res.json(await authService.resetPassword(req.valid)));

export function logout(req, res) {
  clearSessionCookie(res);
  res.status(204).end();
}

export const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user, accounts: await authService.accountsFor(req.user) });
});

export const switchAccount = asyncHandler(async (req, res) => {
  const user = await authService.switchAccount(req.user.id, req.valid.role);
  setSessionCookie(res, await authService.sessionUser(user.id));
  res.json({ user });
});

export const addAccount = asyncHandler(async (req, res) => {
  const user = await authService.addAccount(req.user.id, req.valid);
  setSessionCookie(res, await authService.sessionUser(user.id));
  res.status(201).json({ user });
});

export const updateProfile = asyncHandler(async (req, res) => {
  res.json({ user: await authService.updateProfile(req.user.id, req.valid) });
});

export const areas = (req, res) => res.json(publicGeo());
