import type { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { HttpError } from './errors';

export const SESSION_COOKIE = 'fs_session';
const SESSION_DURATION_SEC = 30 * 24 * 3600; // 30 jours

const oauthVerifier = new OAuth2Client(config.google.clientId);

export function isAllowedEmail(email: string): boolean {
  return config.allowedEmails.includes(email.trim().toLowerCase());
}

/** Vérifie l'ID token Google (venu du bouton Sign-In) et renvoie l'email. */
export async function verifyGoogleIdToken(idToken: string): Promise<string> {
  let email: string | undefined;
  try {
    const ticket = await oauthVerifier.verifyIdToken({
      idToken,
      audience: config.google.clientId,
    });
    email = ticket.getPayload()?.email;
  } catch {
    throw new HttpError(401, 'Jeton Google invalide');
  }
  if (!email) {
    throw new HttpError(401, 'Jeton Google sans email');
  }
  return email.toLowerCase();
}

export function setSessionCookie(res: Response, email: string): void {
  const token = jwt.sign({ email }, config.jwtSecret, {
    expiresIn: SESSION_DURATION_SEC,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: SESSION_DURATION_SEC * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Email de la session courante, ou null si non connecté / session invalide. */
export function sessionEmail(req: Request): string | null {
  const token = (req.cookies as Record<string, string> | undefined)?.[
    SESSION_COOKIE
  ];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { email?: string };
    const email = payload.email?.toLowerCase();
    // Re-contrôle de la liste blanche : un email retiré perd l'accès même avec
    // un JWT encore valide.
    return email && isAllowedEmail(email) ? email : null;
  } catch {
    return null;
  }
}

/** Middleware de gating des routes d'écriture. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!sessionEmail(req)) {
    next(new HttpError(401, 'Connexion requise pour cette action'));
    return;
  }
  next();
}
