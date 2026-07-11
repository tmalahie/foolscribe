import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, formatTimecode, parseTimecode } from '../api';
import { useAuth } from '../auth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  getPinnedAudio,
  getPinnedDetail,
  isPinned,
  pinRecording,
  refreshPinnedDetail,
  unpinRecording,
} from '../offline';
import type {
  RecordingDetail,
  Timeline,
  TimelineEntry,
} from '../types';
import { useOnline } from '../useOnline';

export function RecordingPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const { ensureAuth } = useAuth();
  const online = useOnline();

  const [detail, setDetail] = useState<RecordingDetail | null>(null);
  const [fromPin, setFromPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinnedAudioUrl, setPinnedAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftEntry, setDraftEntry] = useState<TimelineEntry | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<RecordingDetail>(`/api/recordings/${id}`);
      setDetail(data);
      setFromPin(false);
      setError(null);
      // Garde la copie téléchargée à jour (nouvelle analyse, corrections…).
      void refreshPinnedDetail(id, data);
    } catch (err) {
      // Réseau KO : on retombe sur la version téléchargée si elle existe.
      const pinnedDetail = await getPinnedDetail(id).catch(() => null);
      if (pinnedDetail) {
        setDetail(pinnedDetail);
        setFromPin(true);
        setError(null);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Enregistrement inaccessible (hors-ligne ?)',
        );
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // État de téléchargement local + URL de l'audio local le cas échéant.
  useEffect(() => {
    let objectUrl: string | null = null;
    void (async () => {
      const isIt = await isPinned(id).catch(() => false);
      setPinned(isIt);
      if (isIt) {
        const blob = await getPinnedAudio(id).catch(() => null);
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          setPinnedAudioUrl(objectUrl);
        }
      } else {
        setPinnedAudioUrl(null);
      }
    })();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, pinBusy]);

  // Polling tant que l'analyse tourne.
  const analysisStatus = detail?.analysis?.status;
  useEffect(() => {
    if (analysisStatus !== 'pending' && analysisStatus !== 'running') return;
    const interval = setInterval(() => void load(), 3000);
    return () => clearInterval(interval);
  }, [analysisStatus, load]);

  const analyze = async () => {
    setActionError(null);
    if (!(await ensureAuth())) return;
    try {
      await api.post(`/api/recordings/${id}/analyze`);
      void load();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'Lancement impossible',
      );
    }
  };

  const togglePin = async () => {
    setPinBusy(true);
    setActionError(null);
    try {
      if (pinned) {
        await unpinRecording(id);
      } else {
        await pinRecording(id);
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Téléchargement impossible',
      );
    } finally {
      setPinBusy(false);
    }
  };

  const startRenaming = async () => {
    if (!detail) return;
    if (!(await ensureAuth())) return;
    setRenameValue(detail.recording.filename);
    setRenaming(true);
  };

  const saveRename = async () => {
    if (!renameValue.trim() || renameBusy) return;
    setRenameBusy(true);
    setActionError(null);
    try {
      await api.patch(`/api/recordings/${id}`, {
        filename: renameValue.trim(),
      });
      setRenaming(false);
      void load();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'Renommage impossible',
      );
    } finally {
      setRenameBusy(false);
    }
  };

  const askDelete = async () => {
    if (!(await ensureAuth())) return;
    setConfirmingDelete(true);
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    void audio.play().catch(() => {});
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, audio.currentTime + delta);
  };

  const entries = detail?.analysis?.timeline?.entries;

  const saveEntries = async (newEntries: TimelineEntry[]) => {
    const { timeline } = await api.put<{ timeline: Timeline }>(
      `/api/recordings/${id}/timeline`,
      { entries: newEntries },
    );
    setDetail((d) => {
      if (!d?.analysis) return d;
      const updated = { ...d, analysis: { ...d.analysis, timeline } };
      void refreshPinnedDetail(id, updated);
      return updated;
    });
  };

  const toggleEditMode = async () => {
    if (editMode) {
      setEditMode(false);
      setEditingIndex(null);
      setDraftEntry(null);
      return;
    }
    if (!(await ensureAuth())) return;
    setEditMode(true);
  };

  const addEntry = () => {
    setDraftEntry({
      timecodeSec: Math.floor(currentTime),
      type: 'discussion',
      text: '',
    });
    setEditingIndex(null);
  };

  // Ligne active pendant la lecture : la dernière entrée commencée.
  const activeIndex = useMemo(() => {
    if (!entries) return -1;
    let index = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].timecodeSec <= currentTime) index = i;
      else break;
    }
    return index;
  }, [entries, currentTime]);

  // Hors-ligne avec audio téléchargé → blob local.
  const audioSrc = pinnedAudioUrl ?? (online ? `/api/recordings/${id}/audio` : null);

  const recording = detail?.recording;
  const analysis = detail?.analysis ?? null;
  const timeline = analysis?.timeline ?? null;
  const analysisInProgress =
    analysis?.status === 'pending' || analysis?.status === 'running';

  return (
    <div>
      <Link
        to={recording ? `/rehearsals/${recording.rehearsal_id}` : '/'}
        className="text-sm text-zinc-500 hover:text-zinc-300"
      >
        ← Retour
      </Link>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {!detail && !error && (
        <p className="mt-4 text-sm text-zinc-500">Chargement…</p>
      )}

      {recording && (
        <>
          {renaming ? (
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void saveRename()}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-400"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void saveRename()}
                  disabled={!renameValue.trim() || renameBusy}
                  className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
                >
                  {renameBusy ? 'Renommage…' : 'Renommer'}
                </button>
                <button
                  onClick={() => setRenaming(false)}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <>
              <h1 className="mt-2 break-words text-xl font-semibold">
                {recording.filename}
              </h1>
              <div className="mt-1 flex gap-3 text-xs">
                <button
                  onClick={() => void startRenaming()}
                  disabled={!online}
                  className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline disabled:opacity-40"
                >
                  Renommer
                </button>
                <button
                  onClick={() => void askDelete()}
                  disabled={!online}
                  className="text-zinc-500 underline-offset-2 hover:text-red-400 hover:underline disabled:opacity-40"
                >
                  Supprimer
                </button>
              </div>
            </>
          )}
          {fromPin && (
            <p className="mt-1 text-xs text-amber-400">
              Version téléchargée sur cet appareil (mode hors-ligne)
            </p>
          )}

          <div className="sticky top-[53px] z-30 -mx-4 mt-4 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
            {audioSrc ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => skip(-10)}
                  className="shrink-0 rounded-full border border-zinc-700 px-2.5 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                  title="Reculer de 10 secondes"
                >
                  −10
                </button>
                <audio
                  ref={audioRef}
                  controls
                  preload="metadata"
                  src={audioSrc}
                  className="min-w-0 flex-1"
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                />
                <button
                  onClick={() => skip(10)}
                  className="shrink-0 rounded-full border border-zinc-700 px-2.5 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                  title="Avancer de 10 secondes"
                >
                  +10
                </button>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">
                Audio indisponible hors-ligne — appuie sur « Télécharger sur cet
                appareil » quand tu as du réseau.
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void analyze()}
                disabled={!online || analysisInProgress}
                className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
                title={online ? undefined : 'Indisponible hors-ligne'}
              >
                {analysisInProgress
                  ? 'Analyse en cours…'
                  : analysis?.status === 'done'
                    ? 'Relancer l’analyse'
                    : 'Lancer l’analyse'}
              </button>
              <button
                onClick={() => void togglePin()}
                disabled={pinBusy || (!pinned && !online)}
                className={`rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                  pinned
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                    : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                }`}
                title="Pour écouter et relire la timeline même sans réseau (au studio)"
              >
                {pinBusy
                  ? 'Téléchargement…'
                  : pinned
                    ? '✓ Téléchargé — retirer'
                    : 'Télécharger sur cet appareil'}
              </button>
            </div>
            {actionError && (
              <p className="mt-2 text-sm text-red-400">{actionError}</p>
            )}
          </div>

          <section className="mt-5">
            {analysis?.status === 'error' && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                L'analyse a échoué : {analysis.error ?? 'erreur inconnue'}
              </div>
            )}

            {analysisInProgress && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
                <span className="mr-2 inline-block h-3 w-3 animate-pulse rounded-full bg-amber-400 align-middle" />
                Analyse en cours — compte quelques minutes pour une répète d'une
                heure. La page se met à jour toute seule.
              </div>
            )}

            {!analysis && (
              <p className="text-sm text-zinc-500">
                Pas encore d'analyse pour cet enregistrement.
              </p>
            )}

            {entries && timeline && (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                    Timeline
                  </h2>
                  <div className="flex items-center gap-2">
                    {editMode && (
                      <button
                        onClick={addEntry}
                        className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        + Ajouter une ligne
                      </button>
                    )}
                    <button
                      onClick={() => void toggleEditMode()}
                      disabled={!online && !editMode}
                      className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${
                        editMode
                          ? 'border-amber-400/50 bg-amber-400/10 text-amber-400'
                          : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {editMode ? 'Terminer' : 'Corriger la timeline'}
                    </button>
                  </div>
                </div>

                {draftEntry && (
                  <div className="mb-2">
                    <EntryEditor
                      entry={draftEntry}
                      onCancel={() => setDraftEntry(null)}
                      onSave={async (entry) => {
                        await saveEntries([...entries, entry]);
                        setDraftEntry(null);
                      }}
                    />
                  </div>
                )}

                <ol className="space-y-1">
                  {entries.map((entry, i) =>
                    editingIndex === i ? (
                      <li key={i}>
                        <EntryEditor
                          entry={entry}
                          onCancel={() => setEditingIndex(null)}
                          onSave={async (updated) => {
                            const next = entries.slice();
                            next[i] = updated;
                            await saveEntries(next);
                            setEditingIndex(null);
                          }}
                          onDelete={async () => {
                            await saveEntries(entries.filter((_, j) => j !== i));
                            setEditingIndex(null);
                          }}
                        />
                      </li>
                    ) : (
                      <TimelineRow
                        key={i}
                        entry={entry}
                        active={i === activeIndex}
                        onSeek={seekTo}
                        onEdit={editMode ? () => setEditingIndex(i) : undefined}
                      />
                    ),
                  )}
                </ol>
                <p className="mt-4 text-xs text-zinc-600">
                  Timeline générée automatiquement le{' '}
                  {new Date(timeline.generatedAt).toLocaleString('fr-FR')}
                  {timeline.editedAt && (
                    <>
                      {' '}
                      · corrigée le{' '}
                      {new Date(timeline.editedAt).toLocaleString('fr-FR')}
                    </>
                  )}
                </p>
              </>
            )}
          </section>
        </>
      )}

      {confirmingDelete && recording && (
        <ConfirmDialog
          title={`Supprimer « ${recording.filename} » ?`}
          message="L'enregistrement et son analyse seront supprimés. Le fichier audio sera mis à la corbeille du Drive du groupe."
          confirmLabel="Supprimer"
          onConfirm={async () => {
            await api.delete(`/api/recordings/${id}`);
            await unpinRecording(id).catch(() => {});
            navigate(`/rehearsals/${recording.rehearsal_id}`);
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

function TimelineRow({
  entry,
  active,
  onSeek,
  onEdit,
}: {
  entry: TimelineEntry;
  active: boolean;
  onSeek: (seconds: number) => void;
  onEdit?: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active]);

  const isMusic = entry.type === 'music';
  return (
    <li ref={ref} className="flex items-start gap-1">
      <button
        onClick={() => onSeek(entry.timecodeSec)}
        className={`flex w-full min-w-0 items-baseline gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          active
            ? 'bg-amber-400/10 ring-1 ring-amber-400/40'
            : 'hover:bg-zinc-900'
        }`}
      >
        <span
          className={`shrink-0 font-mono text-xs tabular-nums ${
            active ? 'text-amber-400' : 'text-zinc-500'
          }`}
        >
          {formatTimecode(entry.timecodeSec)}
        </span>
        {isMusic ? (
          <span className="text-sm font-medium tracking-wide text-violet-400">
            ♪ [MUSIQUE]
            {entry.endSec != null && (
              <span className="ml-2 font-normal text-zinc-500">
                jusqu'à {formatTimecode(entry.endSec)}
              </span>
            )}
          </span>
        ) : (
          <span className="text-sm text-zinc-200">{entry.text}</span>
        )}
      </button>
      {onEdit && (
        <button
          onClick={onEdit}
          className="mt-1.5 shrink-0 rounded-md border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          title="Corriger cette ligne"
        >
          ✎
        </button>
      )}
    </li>
  );
}

function EntryEditor({
  entry,
  onSave,
  onCancel,
  onDelete,
}: {
  entry: TimelineEntry;
  onSave: (entry: TimelineEntry) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const isMusic = entry.type === 'music';
  const [timecode, setTimecode] = useState(formatTimecode(entry.timecodeSec));
  const [endTimecode, setEndTimecode] = useState(
    entry.endSec != null ? formatTimecode(entry.endSec) : '',
  );
  const [text, setText] = useState(entry.text ?? '');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const save = async () => {
    const timecodeSec = parseTimecode(timecode);
    if (timecodeSec == null) {
      setLocalError('Timecode invalide (format attendu : m:ss)');
      return;
    }
    let updated: TimelineEntry;
    if (isMusic) {
      const endSec = endTimecode.trim() ? parseTimecode(endTimecode) : undefined;
      if (endTimecode.trim() && endSec == null) {
        setLocalError('Timecode de fin invalide (format attendu : m:ss)');
        return;
      }
      if (endSec != null && endSec < timecodeSec) {
        setLocalError('La fin doit être après le début');
        return;
      }
      updated = { timecodeSec, type: 'music', ...(endSec != null ? { endSec } : {}) };
    } else {
      if (!text.trim()) {
        setLocalError('Le texte ne peut pas être vide');
        return;
      }
      updated = {
        timecodeSec,
        type: 'discussion',
        text: text.trim(),
      };
    }
    setBusy(true);
    setLocalError(null);
    try {
      await onSave(updated);
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Enregistrement impossible',
      );
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    if (!window.confirm('Supprimer cette ligne de la timeline ?')) return;
    setBusy(true);
    try {
      await onDelete();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Suppression impossible');
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-400/30 bg-zinc-900 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={timecode}
          onChange={(e) => setTimecode(e.target.value)}
          placeholder="m:ss"
          className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-center font-mono text-xs outline-none focus:border-amber-400"
        />
        {isMusic && (
          <>
            <span className="text-sm text-violet-400">♪ [MUSIQUE] jusqu'à</span>
            <input
              value={endTimecode}
              onChange={(e) => setEndTimecode(e.target.value)}
              placeholder="m:ss"
              className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-center font-mono text-xs outline-none focus:border-amber-400"
            />
          </>
        )}
      </div>
      {!isMusic && (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Résumé de la discussion…"
          className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-400"
        />
      )}
      {localError && <p className="mt-2 text-xs text-red-400">{localError}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
        >
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Annuler
        </button>
        {onDelete && (
          <button
            onClick={() => void remove()}
            disabled={busy}
            className="ml-auto rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            Supprimer la ligne
          </button>
        )}
      </div>
    </div>
  );
}
