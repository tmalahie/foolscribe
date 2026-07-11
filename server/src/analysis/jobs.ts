import type { ResultSetHeader } from 'mysql2';
import { pool } from '../db';
import { HttpError } from '../errors';
import type { AnalysisRow } from '../types';
import { REASONING_MODEL, runPipeline } from './pipeline';

// L'analyse d'une répète d'1 h dépasse largement le timeout d'une requête HTTP :
// job asynchrone in-process, suivi par polling de `analyses.status` (§6 du plan).
const runningRecordings = new Set<number>();

/** Au boot : les analyses laissées pending/running par un arrêt sont perdues. */
export async function resetStaleAnalyses(): Promise<void> {
  await pool.query(
    `UPDATE analyses SET status = 'error', error = 'Interrompue par un redémarrage du serveur'
     WHERE status IN ('pending', 'running')`,
  );
}

async function getAnalysis(id: number): Promise<AnalysisRow> {
  const [rows] = await pool.query<AnalysisRow[]>(
    'SELECT * FROM analyses WHERE id = ?',
    [id],
  );
  return rows[0];
}

export async function latestAnalysis(
  recordingId: number,
): Promise<AnalysisRow | null> {
  const [rows] = await pool.query<AnalysisRow[]>(
    'SELECT * FROM analyses WHERE recording_id = ? ORDER BY id DESC LIMIT 1',
    [recordingId],
  );
  return rows[0] ?? null;
}

export async function startAnalysis(recordingId: number): Promise<AnalysisRow> {
  // Une analyse déjà en cours pour cet enregistrement ? On la renvoie au lieu
  // d'en empiler une deuxième.
  const existing = await latestAnalysis(recordingId);
  if (
    existing &&
    (existing.status === 'pending' || existing.status === 'running')
  ) {
    return existing;
  }
  if (runningRecordings.has(recordingId)) {
    if (existing) return existing;
    throw new HttpError(409, 'Analyse déjà en cours');
  }

  runningRecordings.add(recordingId);
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO analyses (recording_id, status, reasoning_model) VALUES (?, 'pending', ?)`,
    [recordingId, REASONING_MODEL],
  );
  const analysisId = result.insertId;

  setImmediate(async () => {
    try {
      await pool.query(`UPDATE analyses SET status = 'running' WHERE id = ?`, [
        analysisId,
      ]);
      const timeline = await runPipeline(recordingId);
      await pool.query(
        `UPDATE analyses SET status = 'done', timeline_json = ?, error = NULL WHERE id = ?`,
        [JSON.stringify(timeline), analysisId],
      );
      console.log(`[analyse #${recordingId}] terminée (analysis ${analysisId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[analyse #${recordingId}] échec :`, err);
      await pool
        .query(
          `UPDATE analyses SET status = 'error', error = ? WHERE id = ?`,
          [message.slice(0, 5000), analysisId],
        )
        .catch(() => {});
    } finally {
      runningRecordings.delete(recordingId);
    }
  });

  return getAnalysis(analysisId);
}
