import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'sl_session';
const ISSUER = 'sunledger';

export function signSession(user) {
  return jwt.sign({ role: user.role, tv: user.token_version }, env.jwtSecret, {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: String(user.id),
    expiresIn: `${env.sessionDays}d`,
  });
}

export function verifySession(token) {
  return jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER });
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.isProd,
  path: '/',
});

export function setSessionCookie(res, user) {
  res.cookie(SESSION_COOKIE, signSession(user), {
    ...cookieOptions(),
    maxAge: env.sessionDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
