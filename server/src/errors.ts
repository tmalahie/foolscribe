import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

/** Enveloppe un handler async pour router ses rejets vers le middleware d'erreur. */
export function wrap(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Refresh token Drive expiré ou révoqué : seule une nouvelle autorisation
  // du compte du groupe règle le problème. On ne logge pas l'erreur gaxios
  // complète, qui contient le refresh token en clair.
  if (isInvalidGrant(err)) {
    console.error('Google Drive : refresh token expiré ou révoqué (invalid_grant)');
    res.status(503).json({
      error:
        'Accès Google Drive expiré : relancer `npm run get-refresh-token` et mettre à jour GOOGLE_OAUTH_REFRESH_TOKEN',
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
}

function isInvalidGrant(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  return data?.error === 'invalid_grant';
}
