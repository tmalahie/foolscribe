import { Router } from 'express';
import {
  clearSessionCookie,
  isAllowedEmail,
  sessionEmail,
  setSessionCookie,
  verifyGoogleIdToken,
} from '../auth';
import { HttpError, wrap } from '../errors';

export const authRouter = Router();

authRouter.post(
  '/google',
  wrap(async (req, res) => {
    const credential = (req.body as { credential?: string }).credential;
    if (!credential) throw new HttpError(400, 'credential manquant');
    const email = await verifyGoogleIdToken(credential);
    if (!isAllowedEmail(email)) {
      throw new HttpError(403, `${email} n'est pas dans la liste des membres du groupe`);
    }
    setSessionCookie(res, email);
    res.json({ email });
  }),
);

authRouter.get('/me', (req, res) => {
  res.json({ email: sessionEmail(req) });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
