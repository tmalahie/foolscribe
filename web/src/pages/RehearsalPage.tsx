import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, formatSize, formatTimecode } from '../api';
import { useAuth } from '../auth';
import type { Recording, Rehearsal } from '../types';
import { useOnline } from '../useOnline';

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  done: { label: 'analysé', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
  running: { label: 'analyse…', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  pending: { label: 'analyse…', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  error: { label: 'erreur', className: 'border-red-500/40 bg-red-500/10 text-red-400' },
};

export function RehearsalPage() {
  const { id } = useParams();
  const { ensureAuth } = useAuth();
  const online = useOnline();
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .get<{ rehearsal: Rehearsal; recordings: Recording[] }>(
        `/api/rehearsals/${id}/recordings`,
      )
      .then((data) => {
        setRehearsal(data.rehearsal);
        setRecordings(data.recordings);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Impossible de charger la répétition (hors-ligne ?)',
        );
      });
  }, [id]);

  useEffect(load, [load]);

  const onFileChosen = async (file: File) => {
    if (!(await ensureAuth())) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.postForm(`/api/rehearsals/${id}/recordings`, form);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload impossible');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div>
      <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← Répétitions
      </Link>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">
            {rehearsal?.name ?? 'Chargement…'}
          </h1>
          {rehearsal?.date && (
            <p className="mt-0.5 text-sm text-zinc-500">
              {formatDate(rehearsal.date)}
            </p>
          )}
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.flac"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFileChosen(file);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!online || uploading}
            className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
            title={online ? undefined : 'Indisponible hors-ligne'}
          >
            {uploading ? 'Envoi en cours…' : 'Ajouter un enregistrement'}
          </button>
        </div>
      </div>

      {uploading && (
        <p className="mt-3 text-sm text-zinc-400">
          Envoi vers Drive et l'Object Storage — peut prendre un moment pour un
          gros fichier…
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {recordings?.length === 0 && (
        <p className="mt-6 text-sm text-zinc-500">
          Aucun enregistrement dans cette répète.
        </p>
      )}

      <ul className="mt-5 space-y-2">
        {recordings?.map((recording) => {
          const badge = recording.last_analysis_status
            ? STATUS_BADGES[recording.last_analysis_status]
            : null;
          return (
            <li key={recording.id}>
              <Link
                to={`/recordings/${recording.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 transition-colors hover:border-zinc-600"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{recording.filename}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {[
                      recording.duration_sec != null
                        ? formatTimecode(recording.duration_sec)
                        : null,
                      formatSize(recording.size_bytes),
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </div>
                </div>
                {badge && (
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
