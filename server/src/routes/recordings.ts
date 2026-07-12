import { Router } from 'express';
import { requireAuth } from '../auth';
import { pool } from '../db';
import { renameFile, trashFile } from '../drive';
import { HttpError, wrap } from '../errors';
import { latestAnalysis, startAnalysis } from '../analysis/jobs';
import { ensureMirrored, getRecordingOrThrow } from '../recordingService';
import { deleteObject, getObjectStream, presignGetUrl } from '../storage';
import type { Timeline, TimelineEntry, TranscriptionRow } from '../types';

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

recordingsRouter.patch(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const recording = await getRecordingOrThrow(id);
    const filename = (req.body as { filename?: string }).filename?.trim();
    if (!filename) throw new HttpError(400, 'Nom de fichier requis');

    // Drive = source de vérité : le renommage se propage au fichier Drive.
    // (La clé S3 ne bouge pas : elle est interne, l'audio reste servi pareil.)
    if (filename !== recording.filename && recording.drive_file_id) {
      await renameFile(recording.drive_file_id, filename);
    }
    await pool.query('UPDATE recordings SET filename = ? WHERE id = ?', [
      filename,
      id,
    ]);
    const updated = await getRecordingOrThrow(id);
    res.json({ recording: updated });
  }),
);

recordingsRouter.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const recording = await getRecordingOrThrow(id);

    // Corbeille Drive d'abord — si ça échoue, on ne supprime rien en base.
    if (recording.drive_file_id) {
      await trashFile(recording.drive_file_id);
    }
    if (recording.object_key) {
      await deleteObject(recording.object_key).catch(() => {}); // best effort
    }
    await pool.query('DELETE FROM recordings WHERE id = ?', [id]);
    res.json({ ok: true });
  }),
);

/** Édition manuelle de la timeline (l'analyse automatique fait des erreurs). */
recordingsRouter.put(
  '/:id/timeline',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    await getRecordingOrThrow(id);
    const analysis = await latestAnalysis(id);
    if (!analysis || analysis.status !== 'done' || !analysis.timeline_json) {
      throw new HttpError(409, 'Pas de timeline à modifier pour cet enregistrement');
    }

    const rawEntries = (req.body as { entries?: unknown }).entries;
    if (!Array.isArray(rawEntries)) {
      throw new HttpError(400, 'entries manquant');
    }
    const entries: TimelineEntry[] = rawEntries.map((raw) => {
      const e = raw as Partial<TimelineEntry>;
      const timecodeSec = Math.floor(Number(e.timecodeSec));
      if (!Number.isFinite(timecodeSec) || timecodeSec < 0) {
        throw new HttpError(400, 'Timecode invalide');
      }
      if (e.type === 'music') {
        const endSec =
          e.endSec != null ? Math.floor(Number(e.endSec)) : undefined;
        if (endSec != null && (!Number.isFinite(endSec) || endSec < timecodeSec)) {
          throw new HttpError(400, 'Fin de passage musical invalide');
        }
        // Libellé optionnel (« refrain idée 2 »…)
        const label =
          typeof e.text === 'string' && e.text.trim() ? e.text.trim() : undefined;
        return {
          timecodeSec,
          type: 'music',
          ...(label ? { text: label } : {}),
          ...(endSec != null ? { endSec } : {}),
        };
      }
      if (e.type !== 'discussion') {
        throw new HttpError(400, 'Type d\'entrée invalide');
      }
      const text = typeof e.text === 'string' ? e.text.trim() : '';
      if (!text) throw new HttpError(400, 'Texte requis pour une entrée de discussion');
      const speaker =
        typeof e.speaker === 'string' && e.speaker.trim()
          ? e.speaker.trim()
          : undefined;
      return {
        timecodeSec,
        type: 'discussion',
        ...(speaker ? { speaker } : {}),
        text,
      };
    });
    entries.sort((a, b) => a.timecodeSec - b.timecodeSec);

    const timeline = JSON.parse(analysis.timeline_json) as Timeline;
    const updated: Timeline = {
      ...timeline,
      entries,
      editedAt: new Date().toISOString(),
    };
    await pool.query('UPDATE analyses SET timeline_json = ? WHERE id = ?', [
      JSON.stringify(updated),
      analysis.id,
    ]);
    res.json({ timeline: updated });
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
