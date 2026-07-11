import { Router } from 'express';
import type { ResultSetHeader } from 'mysql2';
import { requireAuth } from '../auth';
import { config } from '../config';
import { pool } from '../db';
import { listChildFolders, listFiles, looksLikeAudio } from '../drive';
import { HttpError, wrap } from '../errors';
import type { RehearsalRow } from '../types';

export const syncRouter = Router();

/** Tente d'extraire une date AAAA-MM-JJ ou JJ-MM-AAAA du nom d'un dossier. */
function dateFromName(name: string): string | null {
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = name.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  return null;
}

/**
 * Resynchro Drive→MySQL : des fichiers/dossiers sont parfois ajoutés
 * directement dans Drive. Upsert par drive_folder_id / drive_file_id (§7).
 */
syncRouter.post(
  '/',
  requireAuth,
  wrap(async (_req, res) => {
    if (!config.google.driveRootFolderId) {
      throw new HttpError(503, 'GOOGLE_DRIVE_ROOT_FOLDER_ID non configuré');
    }

    let newRehearsals = 0;
    let newRecordings = 0;
    let scannedFiles = 0;

    const folders = await listChildFolders(config.google.driveRootFolderId);
    for (const folder of folders) {
      const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO rehearsals (name, date, drive_folder_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [folder.name, dateFromName(folder.name), folder.id],
      );
      if (result.affectedRows === 1) newRehearsals++;

      const [rows] = await pool.query<RehearsalRow[]>(
        'SELECT id FROM rehearsals WHERE drive_folder_id = ?',
        [folder.id],
      );
      const rehearsalId = rows[0].id;

      const files = (await listFiles(folder.id)).filter(looksLikeAudio);
      scannedFiles += files.length;
      for (const file of files) {
        const [fileResult] = await pool.query<ResultSetHeader>(
          `INSERT INTO recordings (rehearsal_id, filename, drive_file_id, size_bytes)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE filename = VALUES(filename), size_bytes = VALUES(size_bytes)`,
          [rehearsalId, file.name, file.id, file.sizeBytes],
        );
        if (fileResult.affectedRows === 1) newRecordings++;
      }
    }

    res.json({
      rehearsals: folders.length,
      recordings: scannedFiles,
      newRehearsals,
      newRecordings,
    });
  }),
);
