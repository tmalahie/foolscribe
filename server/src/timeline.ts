import { latestAnalysis } from './analysis/jobs';
import { pool } from './db';
import { HttpError } from './errors';
import type { AnalysisRow, Timeline, TimelineEntry } from './types';

/** Valide et normalise une entrée de timeline venue du front ou du chat. */
export function normalizeEntry(raw: unknown): TimelineEntry {
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
}

/** Analyse terminée de l'enregistrement, la seule dont la timeline s'édite. */
export async function editableAnalysis(recordingId: number): Promise<AnalysisRow> {
  const analysis = await latestAnalysis(recordingId);
  if (!analysis || analysis.status !== 'done' || !analysis.timeline_json) {
    throw new HttpError(409, 'Pas de timeline à modifier pour cet enregistrement');
  }
  return analysis;
}

/** Remplace les entrées de la timeline (triées) et marque la timeline éditée. */
export async function saveTimelineEntries(
  analysis: AnalysisRow,
  entries: TimelineEntry[],
): Promise<Timeline> {
  const sorted = [...entries].sort((a, b) => a.timecodeSec - b.timecodeSec);
  const timeline = JSON.parse(analysis.timeline_json!) as Timeline;
  const updated: Timeline = {
    ...timeline,
    entries: sorted,
    editedAt: new Date().toISOString(),
  };
  await pool.query('UPDATE analyses SET timeline_json = ? WHERE id = ?', [
    JSON.stringify(updated),
    analysis.id,
  ]);
  return updated;
}
