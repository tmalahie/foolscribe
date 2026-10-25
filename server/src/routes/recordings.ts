import { spawn } from 'child_process';
import { Router } from 'express';
import type { Response } from 'express';
import { requireAuth, sessionEmail } from '../auth';
import { clearChat, listChatMessages, pendingTurn, startChatTurn } from '../chat';
import { pool } from '../db';
import { renameFile, trashFile } from '../drive';
import { HttpError, wrap } from '../errors';
import { latestAnalysis, startAnalysis } from '../analysis/jobs';
import {
  downloadToTmp,
  ensureMirrored,
  getRecordingOrThrow,
} from '../recordingService';
import { deleteObject, getObjectStream, presignGetUrl } from '../storage';
import { editableAnalysis, normalizeEntry, saveTimelineEntries } from '../timeline';
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

const SEGMENT_BITRATE = '192k';

/** « 30s », « 1m30s », « 1h02m30s » — même convention que le paramètre ?t= du front. */
function stampSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}h${pad(m)}m${pad(s)}s`;
  if (m > 0) return `${m}m${pad(s)}s`;
  return `${s}s`;
}

function segmentFilename(
  filename: string,
  startSec: number,
  endSec: number | null,
): string {
  const base = filename.replace(/\.[^./]+$/, '') || 'extrait';
  const end = endSec != null ? stampSeconds(endSec) : 'fin';
  return `${base} ${stampSeconds(startSec)}-${end}.mp3`.replace(
    /[/\\?%*:|"<>]/g,
    '_',
  );
}

function parseSeconds(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Octets gardés en mémoire avant d'écrire quoi que ce soit dans la réponse :
 * ffmpeg émet l'en-tête MP3 (~150 octets) avant même d'avoir démuxé l'entrée, si
 * bien qu'un échec de lecture arrive après les premiers octets produits. Tant
 * qu'on n'a rien envoyé, la réponse reste intacte et le repli local est possible.
 * ~10 s d'audio à 192 kb/s : les erreurs de démuxage se voient bien avant.
 */
const SEGMENT_HOLD_BYTES = 256 * 1024;

/**
 * Transcode l'extrait vers `res` en streaming. `-ss` avant `-i` = seek à
 * l'entrée : sur une URL présignée, ffmpeg n'en lit que les octets utiles
 * (Range HTTP) au lieu de rapatrier tout le fichier.
 *
 * `holdBytes` diffère la première écriture (voir SEGMENT_HOLD_BYTES) ; à 0, la
 * réponse part dès le premier octet.
 */
function streamSegment(
  input: string,
  startSec: number,
  durationSec: number | null,
  res: Response,
  sendHeaders: () => void,
  holdBytes: number,
): Promise<void> {
  const args = [
    '-v',
    'error',
    // Sans -xerror, ffmpeg sort en 0 même après une erreur de démuxage : on
    // servirait un MP3 corrompu en croyant que tout s'est bien passé.
    '-xerror',
    ...(/^https?:/.test(input)
      ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
      : []),
    '-ss',
    startSec.toFixed(3),
    '-i',
    input,
    ...(durationSec != null ? ['-t', durationSec.toFixed(3)] : []),
    '-vn', // pas de pochette dans l'extrait
    '-c:a',
    'libmp3lame',
    '-b:a',
    SEGMENT_BITRATE,
    '-f',
    'mp3',
    'pipe:1',
  ];

  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let produced = 0;
    let committed = false;
    let settled = false;
    let held: Buffer[] = [];

    const commit = () => {
      if (committed) return;
      committed = true;
      sendHeaders();
      for (const chunk of held) res.write(chunk);
      held = [];
    };
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      produced += chunk.length;
      if (!committed) {
        held.push(chunk);
        if (produced < holdBytes) return;
        commit();
        return;
      }
      if (!res.write(chunk)) child.stdout.pause();
    });
    res.on('drain', () => child.stdout.resume());
    // Client parti (onglet fermé, partage annulé) : inutile de transcoder dans le vide.
    res.on('close', () => {
      if (!res.writableEnded) child.kill('SIGKILL');
    });
    child.on('error', settle);
    child.on('close', (code) => {
      if (code === 0 && produced > 0) {
        commit(); // extrait plus court que le tampon : rien n'est encore parti
        res.end();
        settle();
        return;
      }
      settle(
        new Error(
          code === 0
            ? 'ffmpeg n’a produit aucun octet (passage hors de l’enregistrement ?)'
            : `ffmpeg a échoué (code ${code}) : ${stderr.trim().split('\n').pop() ?? ''}`,
        ),
      );
    });
  });
}

/**
 * Extrait audio [start, end[ d'un enregistrement, encodé en MP3 à la volée —
 * pour télécharger ou partager un passage repéré dans la timeline.
 */
recordingsRouter.get(
  '/:id/segment',
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const recording = await getRecordingOrThrow(id);

    const startSec = parseSeconds(req.query.start) ?? 0;
    const endSec = req.query.end != null ? parseSeconds(req.query.end) : null;
    if (req.query.end != null && endSec == null) {
      throw new HttpError(400, 'Fin de passage invalide');
    }
    if (endSec != null && endSec <= startSec) {
      throw new HttpError(400, 'La fin du passage doit suivre son début');
    }
    const durationSec = endSec != null ? endSec - startSec : null;

    const key = await ensureMirrored(recording);
    const name = segmentFilename(recording.filename, startSec, endSec);
    const sendHeaders = () => {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
    };

    try {
      try {
        await streamSegment(
          await presignGetUrl(key),
          startSec,
          durationSec,
          res,
          sendHeaders,
          SEGMENT_HOLD_BYTES,
        );
      } catch (err) {
        if (res.headersSent) throw err;
        // ffmpeg sans support https, ou Object Storage capricieux : on retombe
        // sur une copie locale complète (plus lent, mais ça passe toujours).
        console.warn(
          `[extrait #${id}] lecture distante impossible, repli sur une copie locale :`,
          err,
        );
        const localPath = await downloadToTmp(recording);
        // Plus de repli derrière : on peut streamer dès le premier octet.
        await streamSegment(localPath, startSec, durationSec, res, sendHeaders, 0);
      }
    } catch (err) {
      console.error(`[extrait #${id}]`, err);
      if (res.headersSent) {
        // Déjà en train de streamer : on coupe net, le client verra un transfert
        // interrompu plutôt qu'un fichier tronqué qui a l'air valide.
        res.destroy();
        return;
      }
      throw new HttpError(502, 'Extraction du passage impossible');
    }
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
    const analysis = await editableAnalysis(id);

    const rawEntries = (req.body as { entries?: unknown }).entries;
    if (!Array.isArray(rawEntries)) {
      throw new HttpError(400, 'entries manquant');
    }
    const timeline = await saveTimelineEntries(
      analysis,
      rawEntries.map(normalizeEntry),
    );
    res.json({ timeline });
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

/** Conversation partagée du chat de l'enregistrement (membres connectés). */
recordingsRouter.get(
  '/:id/chat',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    await getRecordingOrThrow(id);
    res.json({ messages: await listChatMessages(id), pending: pendingTurn(id) });
  }),
);

recordingsRouter.post(
  '/:id/chat',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const message = (req.body as { message?: unknown }).message;
    if (typeof message !== 'string') throw new HttpError(400, 'message manquant');
    await getRecordingOrThrow(id);
    res.status(202).json({ pending: startChatTurn(id, sessionEmail(req)!, message) });
  }),
);

recordingsRouter.delete(
  '/:id/chat',
  requireAuth,
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (pendingTurn(id) && !pendingTurn(id)!.error) {
      throw new HttpError(409, 'Une réponse est en cours');
    }
    await clearChat(id);
    res.json({ ok: true });
  }),
);
