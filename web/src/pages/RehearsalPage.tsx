import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, formatSize, formatTimecode } from '../api';
import { useAuth } from '../auth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import type { Recording, Rehearsal } from '../types';
import { useOnline } from '../useOnline';

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  done: { label: 'analysé', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' },
  running: { label: 'analyse…', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  pending: { label: 'analyse…', className: 'border-amber-500/40 bg-amber-500/10 text-amber-400' },
  error: { label: 'analyse échouée', className: 'border-red-500/40 bg-red-500/10 text-red-400' },
};

export function RehearsalPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { ensureAuth } = useAuth();
  const online = useOnline();
  const [rehearsal, setRehearsal] = useState<Rehearsal | null>(null);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
      err instanceof ApiError
        ? setError(err.message)
        : setError("L'importation a échoué, réessaie.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const startEditing = async () => {
    if (!rehearsal) return;
    if (!(await ensureAuth())) return;
    setEditName(rehearsal.name);
    setEditDate(rehearsal.date ? rehearsal.date.slice(0, 10) : '');
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editName.trim() || editBusy) return;
    setEditBusy(true);
    setError(null);
    try {
      await api.patch(`/api/rehearsals/${id}`, {
        name: editName.trim(),
        date: editDate || null,
      });
      setEditing(false);
      load();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Modification impossible',
      );
    } finally {
      setEditBusy(false);
    }
  };

  const askDelete = async () => {
    if (!(await ensureAuth())) return;
    setConfirmingDelete(true);
  };

  return (
    <div>
      <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← Répétitions
      </Link>

      {editing ? (
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveEdit()}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-400"
            />
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-400"
            />
            <div className="flex gap-2">
              <button
                onClick={() => void saveEdit()}
                disabled={!editName.trim() || editBusy}
                className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
              >
                {editBusy ? 'Enregistrement…' : 'Enregistrer'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Annuler
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Renommer la répète renomme aussi son dossier dans le Drive du
            groupe.
          </p>
        </div>
      ) : (
        <div className="mt-2 flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">
              {rehearsal?.name ?? 'Chargement…'}
            </h1>
            {rehearsal?.date && (
              <p className="mt-0.5 text-sm text-zinc-500">
                {formatDate(rehearsal.date)}
              </p>
            )}
            {rehearsal && (
              <div className="mt-1 flex gap-3 text-xs">
                <button
                  onClick={() => void startEditing()}
                  disabled={!online}
                  className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline disabled:opacity-40"
                >
                  Modifier
                </button>
                <button
                  onClick={() => void askDelete()}
                  disabled={!online}
                  className="text-zinc-500 underline-offset-2 hover:text-red-400 hover:underline disabled:opacity-40"
                >
                  Supprimer
                </button>
              </div>
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
              {uploading ? 'Importation…' : 'Ajouter un enregistrement'}
            </button>
          </div>
        </div>
      )}

      {uploading && (
        <p className="mt-3 text-sm text-zinc-400">
          Importation de l'audio — ça peut prendre un moment pour un gros
          fichier…
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

      {confirmingDelete && rehearsal && (
        <ConfirmDialog
          title={`Supprimer « ${rehearsal.name} » ?`}
          message="La répète, ses enregistrements et leurs analyses seront supprimés. Le dossier sera mis à la corbeille du Drive du groupe."
          confirmLabel="Supprimer"
          onConfirm={async () => {
            await api.delete(`/api/rehearsals/${id}`);
            navigate('/');
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
