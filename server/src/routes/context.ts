import { Router } from 'express';
import { requireAuth } from '../auth';
import { BAND_CONTEXT_MAX_CHARS, getBandContext, setBandContext } from '../bandContext';
import { HttpError, wrap } from '../errors';

/** Contexte du groupe (voir bandContext.ts), édité à la main depuis l'appli. */
export const contextRouter = Router();

contextRouter.get(
  '/',
  requireAuth,
  wrap(async (_req, res) => {
    res.json({ content: await getBandContext(), maxChars: BAND_CONTEXT_MAX_CHARS });
  }),
);

contextRouter.put(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const content = (req.body as { content?: unknown }).content;
    if (typeof content !== 'string') throw new HttpError(400, 'content manquant');
    res.json({ content: await setBandContext(content), maxChars: BAND_CONTEXT_MAX_CHARS });
  }),
);
