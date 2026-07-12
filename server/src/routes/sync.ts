import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { requireAuth } from '../auth';
import { config } from '../config';
import { pool } from '../db';
import { listChildFolders, listFiles, looksLikeAudio } from '../drive';
import { HttpError, wrap } from '../errors';
import { deleteObject } from '../storage';
import type { RecordingRow, RehearsalRow } from '../types';

export const syncRouter = Router();

/**
 * Tente d'extraire une date du nom d'un dossier. Formats couverts :
 * AAAA-MM-JJ, et les conventions du groupe « répète du 2/02/25 »,
 * « répète du 24/9/25 », « 24-09-2025 »… (jour/mois sur 1-2 chiffres,
 * année sur 2 ou 4 chiffres, séparateur / ou -).
 */
export function dateFromName(name: string): string | null {
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const fr = name.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?!\d)/);
  if (fr) {
    const day = parseInt(fr[1], 10);
    const month = parseInt(fr[2], 10);
    const yearRaw = fr[3];
    if (yearRaw.length === 3) return null;
    const year = yearRaw.length === 2 ? 2000 + parseInt(yearRaw, 10) : parseInt(yearRaw, 10);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
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

    // affectedRows d'un upsert est ambigu selon le serveur : on compte le
    // « nouveau » en comparant à l'état préalable.
    const [knownRehearsalRows] = await pool.query<RehearsalRow[]>(
      'SELECT drive_folder_id FROM rehearsals WHERE drive_folder_id IS NOT NULL',
    );
    const knownFolders = new Set(knownRehearsalRows.map((r) => r.drive_folder_id));
    const [knownRecordingRows] = await pool.query<RowDataPacket[]>(
      'SELECT drive_file_id FROM recordings WHERE drive_file_id IS NOT NULL',
    );
    const knownFiles = new Set(
      knownRecordingRows.map((r) => r.drive_file_id as string),
    );

    const folders = await listChildFolders(config.google.driveRootFolderId);
    const driveFileIds = new Set<string>();
    for (const folder of folders) {
      // La date déduite du nom ne remplit que les trous : une date posée à la
      // main dans l'app n'est jamais écrasée par la synchro.
      await pool.query<ResultSetHeader>(
        `INSERT INTO rehearsals (name, date, drive_folder_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), date = COALESCE(date, VALUES(date))`,
        [folder.name, dateFromName(folder.name), folder.id],
      );
      if (!knownFolders.has(folder.id)) newRehearsals++;

      const [rows] = await pool.query<RehearsalRow[]>(
        'SELECT id FROM rehearsals WHERE drive_folder_id = ?',
        [folder.id],
      );
      const rehearsalId = rows[0].id;

      const files = (await listFiles(folder.id)).filter(looksLikeAudio);
      scannedFiles += files.length;
      for (const file of files) {
        driveFileIds.add(file.id);
        await pool.query<ResultSetHeader>(
          `INSERT INTO recordings (rehearsal_id, filename, drive_file_id, size_bytes)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE filename = VALUES(filename), size_bytes = VALUES(size_bytes)`,
          [rehearsalId, file.name, file.id, file.sizeBytes],
        );
        if (!knownFiles.has(file.id)) newRecordings++;
      }
    }

    // Drive est la source de vérité dans les deux sens : ce qui a disparu de
    // Drive disparaît aussi de la base (et son mirror de l'Object Storage).
    // Les enregistrements des dossiers supprimés passent ici aussi (leurs
    // fichiers ne sont plus listés), ce qui nettoie leur audio avant que la
    // suppression de la répète ne fasse le reste en cascade.
    let removedRecordings = 0;
    const [allRecordings] = await pool.query<RecordingRow[]>(
      'SELECT * FROM recordings WHERE drive_file_id IS NOT NULL',
    );
    for (const rec of allRecordings) {
      if (driveFileIds.has(rec.drive_file_id!)) continue;
      if (rec.object_key) {
        await deleteObject(rec.object_key).catch(() => {}); // best effort
      }
      await pool.query('DELETE FROM recordings WHERE id = ?', [rec.id]);
      removedRecordings++;
    }

    let removedRehearsals = 0;
    const driveFolderIds = new Set(folders.map((f) => f.id));
    const [allRehearsals] = await pool.query<RehearsalRow[]>(
      'SELECT * FROM rehearsals WHERE drive_folder_id IS NOT NULL',
    );
    for (const rehearsal of allRehearsals) {
      if (driveFolderIds.has(rehearsal.drive_folder_id!)) continue;
      await pool.query('DELETE FROM rehearsals WHERE id = ?', [rehearsal.id]);
      removedRehearsals++;
    }

    res.json({
      rehearsals: folders.length,
      recordings: scannedFiles,
      newRehearsals,
      newRecordings,
      removedRehearsals,
      removedRecordings,
    });
  }),
);
