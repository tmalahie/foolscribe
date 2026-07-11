import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline as streamPipeline } from 'stream/promises';
import { pool } from './db';
import { downloadFile } from './drive';
import { HttpError } from './errors';
import { audioMimeType, getObjectStream, uploadStream } from './storage';
import type { RecordingRow } from './types';

export const TMP_DIR = path.join(os.tmpdir(), 'foolscribe');

export async function getRecordingOrThrow(id: number): Promise<RecordingRow> {
  const [rows] = await pool.query<RecordingRow[]>(
    'SELECT * FROM recordings WHERE id = ?',
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Enregistrement introuvable');
  return rows[0];
}

export function objectKeyFor(recordingId: number, filename: string): string {
  const safe = filename.replace(/[^\w.\-]/g, '_');
  return `recordings/${recordingId}/${safe}`;
}

/**
 * Garantit que l'audio est présent dans l'Object Storage (mirror paresseux
 * Drive→S3 pour les fichiers déposés directement dans Drive) et renvoie la clé.
 */
export async function ensureMirrored(rec: RecordingRow): Promise<string> {
  if (rec.object_key) return rec.object_key;
  if (!rec.drive_file_id) {
    throw new HttpError(500, 'Enregistrement sans fichier Drive ni mirror S3');
  }
  const key = objectKeyFor(rec.id, rec.filename);
  const driveStream = await downloadFile(rec.drive_file_id);
  await uploadStream(key, driveStream, audioMimeType(rec.filename));
  await pool.query(
    'UPDATE recordings SET object_key = ?, mirrored_at = NOW() WHERE id = ?',
    [key, rec.id],
  );
  rec.object_key = key;
  return key;
}

/** Télécharge l'audio (depuis le mirror S3) vers un fichier temporaire local. */
export async function downloadToTmp(rec: RecordingRow): Promise<string> {
  const key = await ensureMirrored(rec);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ext = path.extname(rec.filename) || '.bin';
  const localPath = path.join(TMP_DIR, `rec-${rec.id}${ext}`);
  const { body } = await getObjectStream(key);
  await streamPipeline(body, fs.createWriteStream(localPath));
  return localPath;
}
