import type { RowDataPacket } from 'mysql2';

export interface RehearsalRow extends RowDataPacket {
  id: number;
  name: string;
  date: string | null;
  drive_folder_id: string | null;
  created_at: string;
}

export interface RecordingRow extends RowDataPacket {
  id: number;
  rehearsal_id: number;
  filename: string;
  drive_file_id: string | null;
  duration_sec: number | null;
  size_bytes: number | null;
  object_key: string | null;
  mirrored_at: string | null;
  created_at: string;
}

export interface TranscriptionRow extends RowDataPacket {
  id: number;
  recording_id: number;
  words_json: string;
  language: string | null;
  created_at: string;
}

export type AnalysisStatus = 'pending' | 'running' | 'done' | 'error';

export interface AnalysisRow extends RowDataPacket {
  id: number;
  recording_id: number;
  status: AnalysisStatus;
  timeline_json: string | null;
  reasoning_model: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Une entrée de la timeline structurée (§4.3 du plan). */
export interface TimelineEntry {
  timecodeSec: number;
  type: 'discussion' | 'music';
  speaker?: string;
  text?: string;
  endSec?: number;
}

export interface Timeline {
  generatedAt: string;
  editedAt?: string;
  model: { stt: string; reasoning: string };
  entries: TimelineEntry[];
}
