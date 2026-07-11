export interface Rehearsal {
  id: number;
  name: string;
  date: string | null;
  drive_folder_id: string | null;
  created_at: string;
  recordings_count?: number;
}

export type AnalysisStatus = 'pending' | 'running' | 'done' | 'error';

export interface Recording {
  id: number;
  rehearsal_id: number;
  filename: string;
  drive_file_id: string | null;
  duration_sec: number | null;
  size_bytes: number | null;
  object_key: string | null;
  mirrored_at: string | null;
  created_at: string;
  last_analysis_status?: AnalysisStatus | null;
}

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

export interface Analysis {
  id: number;
  status: AnalysisStatus;
  reasoningModel: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: Timeline | null;
}

export interface RecordingDetail {
  recording: Recording;
  analysis: Analysis | null;
  transcriptionCached: boolean;
}
