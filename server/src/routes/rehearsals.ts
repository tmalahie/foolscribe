import { Router } from 'express';
import { execFile } from 'child_process';
import * as fs from 'fs';
import multer from 'multer';
import type { ResultSetHeader } from 'mysql2';
import { promisify } from 'util';
import { requireAuth } from '../auth';
import { pool } from '../db';
import { createFolder, uploadFile } from '../drive';
import { HttpError, wrap } from '../errors';
import { objectKeyFor, TMP_DIR } from '../recordingService';
import { audioMimeType, uploadStream } from '../storage';
import type { RecordingRow, RehearsalRow } from '../types';

const execFileAsync = promisify(execFile);

export const rehearsalsRouter = Router();

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 },
});

rehearsalsRouter.get(
  '/',
  wrap(async (_req, res) => {
    const [rows] = await pool.query<RehearsalRow[]>(
      `SELECT r.*, COUNT(rec.id) AS recordings_count
       FROM rehearsals r
       LEFT JOIN recordings rec ON rec.rehearsal_id = r.id
       GROUP BY r.id
       ORDER BY COALESCE(r.date, DATE(r.created_at)) DESC, r.id DESC`,
    );
    res.json({ rehearsals: rows });
  }),
);

rehearsalsRouter.post(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const { name, date } = req.body as { name?: string; date?: string };
    const trimmed = name?.trim();
    if (!trimmed) throw new HttpError(400, 'Nom de répétition requis');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, 'Date invalide (format attendu : AAAA-MM-JJ)');
    }

    // La répète naît des deux côtés : dossier Drive (source de vérité) + ligne DB.
    const folderId = await createFolder(trimmed);
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO rehearsals (name, date, drive_folder_id) VALUES (?, ?, ?)',
      [trimmed, date ?? null, folderId],
    );
    const [rows] = await pool.query<RehearsalRow[]>(
      'SELECT * FROM rehearsals WHERE id = ?',
      [result.insertId],
    );
    res.status(201).json({ rehearsal: rows[0] });
  }),
);

rehearsalsRouter.get(
  '/:id/recordings',
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const [rehearsals] = await pool.query<RehearsalRow[]>(
      'SELECT * FROM rehearsals WHERE id = ?',
      [id],
    );
    if (!rehearsals[0]) throw new HttpError(404, 'Répétition introuvable');
    const [recordings] = await pool.query<RecordingRow[]>(
      `SELECT rec.*, a.status AS last_analysis_status
       FROM recordings rec
       LEFT JOIN analyses a ON a.id = (
         SELECT MAX(a2.id) FROM analyses a2 WHERE a2.recording_id = rec.id
       )
       WHERE rec.rehearsal_id = ?
       ORDER BY rec.created_at ASC, rec.id ASC`,
      [id],
    );
    res.json({ rehearsal: rehearsals[0], recordings });
  }),
);

rehearsalsRouter.post(
  '/:id/recordings',
  requireAuth,
  upload.single('file'),
  wrap(async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    const file = req.file;
    if (!file) throw new HttpError(400, 'Fichier audio manquant (champ "file")');

    try {
      const [rehearsals] = await pool.query<RehearsalRow[]>(
        'SELECT * FROM rehearsals WHERE id = ?',
        [id],
      );
      const rehearsal = rehearsals[0];
      if (!rehearsal) throw new HttpError(404, 'Répétition introuvable');
      if (!rehearsal.drive_folder_id) {
        throw new HttpError(500, 'Répétition sans dossier Drive associé');
      }

      // multer décode originalname en latin1 : on restaure l'UTF-8 (accents).
      const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const mimeType = audioMimeType(filename);

      let durationSec: number | null = null;
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          file.path,
        ]);
        const parsed = parseFloat(stdout.trim());
        durationSec = Number.isFinite(parsed) ? Math.round(parsed) : null;
      } catch {
        // durée inconnue, non bloquant
      }

      // Drive = source de vérité : on écrit d'abord dans Drive, puis on mirrore
      // dans l'Object Storage (audio servi), puis la ligne DB (§7 du plan).
      const driveFile = await uploadFile(
        rehearsal.drive_folder_id,
        filename,
        mimeType,
        fs.createReadStream(file.path),
      );

      const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO recordings (rehearsal_id, filename, drive_file_id, duration_sec, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [id, filename, driveFile.id, durationSec, file.size],
      );
      const recordingId = result.insertId;

      const key = objectKeyFor(recordingId, filename);
      await uploadStream(key, fs.createReadStream(file.path), mimeType);
      await pool.query(
        'UPDATE recordings SET object_key = ?, mirrored_at = NOW() WHERE id = ?',
        [key, recordingId],
      );

      const [rows] = await pool.query<RecordingRow[]>(
        'SELECT * FROM recordings WHERE id = ?',
        [recordingId],
      );
      res.status(201).json({ recording: rows[0] });
    } finally {
      fs.rmSync(file.path, { force: true });
    }
  }),
);
