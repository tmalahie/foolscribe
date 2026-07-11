import { Router } from 'express';
import { requireAuth } from '../auth';
import { pool } from '../db';
import { wrap } from '../errors';
import { latestAnalysis, startAnalysis } from '../analysis/jobs';
import { ensureMirrored, getRecordingOrThrow } from '../recordingService';
import { getObjectStream, presignGetUrl } from '../storage';
import type { Timeline, TranscriptionRow } from '../types';

export const recordingsRouter = Router();

recordingsRouter.get(
  '/:id',
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const recording = await getRecordingOrThrow(id);
    const analysis = await latestAnalysis(id);
    const [transcriptions] = await pool.query<TranscriptionRow[]>(
      'SELECT id FROM transcriptions WHERE recording_id = ?',
      [id],
    );
    res.json({
      recording,
      analysis: analysis
        ? {
            id: analysis.id,
            status: analysis.status,
            reasoningModel: analysis.reasoning_model,
            error: analysis.error,
            createdAt: analysis.created_at,
            updatedAt: analysis.updated_at,
            timeline: analysis.timeline_json
              ? (JSON.parse(analysis.timeline_json) as Timeline)
              : null,
          }
        : null,
      transcriptionCached: transcriptions.length > 0,
    });
  }),
);

recordingsRouter.get(
  '/:id/audio',
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const recording = await getRecordingOrThrow(id);
    // Mirror paresseux Drive→S3 si le fichier a été déposé directement dans
    // Drive et n'a pas encore été copié (§7 du plan).
    const key = await ensureMirrored(recording);

    if (req.query.stream === '1') {
      // Flux via le serveur (même origine) — utilisé par le téléchargement
      // « disponible hors-ligne » pour éviter le CORS de l'Object Storage.
      const range = req.headers.range;
      const object = await getObjectStream(key, range);
      res.status(object.statusCode);
      res.setHeader('Accept-Ranges', 'bytes');
      if (object.contentType) res.setHeader('Content-Type', object.contentType);
      if (object.contentLength != null) {
        res.setHeader('Content-Length', object.contentLength);
      }
      if (object.contentRange) {
        res.setHeader('Content-Range', object.contentRange);
      }
      object.body.pipe(res);
      return;
    }

    // Cas nominal : redirection vers une URL présignée de l'Object Storage. Le
    // navigateur lit l'audio directement (Range natif, seek), sans consommer la
    // bande passante du serveur.
    const url = await presignGetUrl(key);
    res.redirect(302, url);
  }),
);

recordingsRouter.post(
  '/:id/analyze',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    await getRecordingOrThrow(id);
    const analysis = await startAnalysis(id);
    res.status(202).json({
      analysis: {
        id: analysis.id,
        status: analysis.status,
        reasoningModel: analysis.reasoning_model,
        error: analysis.error,
        createdAt: analysis.created_at,
        updatedAt: analysis.updated_at,
        timeline: null,
      },
    });
  }),
);
