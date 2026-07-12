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

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 translate-x-px" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function SkipTenIcon({ direction }: { direction: 'back' | 'forward' }) {
  const isForward = direction === 'forward';
  // Boucle ouverte en haut (gap de ~70°) + pointe de flèche, dessinée pour la
  // rotation « avancer » (sens horaire) ; on la miroite pour « reculer ».
  return (
    <svg viewBox="0 0 36 36" className="h-12 w-12" fill="none">
      <g transform={isForward ? 'scale(-1,1) translate(-36,0)' : undefined}>
        <path
          d="M18 6.5 A11.5 11.5 0 1 1 8.0 13.0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
        {/* Pointe de flèche au sommet, dans le sens de la rotation horaire. */}
        <path
          d="M18 2.5 L18 10.5 L12 6.5 Z"
          fill="currentColor"
        />
      </g>
      <text
        x="18"
        y="19"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="7.5"
        fontWeight="600"
        fill="currentColor"
      >
        {isForward ? '+10' : '−10'}
      </text>
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

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
  const [duration, setDuration] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingAnalyze, setConfirmingAnalyze] = useState(false);
  const [confirmingUnpin, setConfirmingUnpin] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftEntry, setDraftEntry] = useState<TimelineEntry | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playerMenuOpen, setPlayerMenuOpen] = useState(false);
  const [rateSubmenuOpen, setRateSubmenuOpen] = useState(false);
  const [downloadingAudio, setDownloadingAudio] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playerMenuRef = useRef<HTMLDivElement>(null);

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

  const downloadPin = async () => {
    setPinBusy(true);
    setActionError(null);
    try {
      await pinRecording(id);
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
    void audio.play().catch(() => { });
  };

  const skip = (delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, audio.currentTime + delta);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => { });
    else audio.pause();
  };

  const closePlayerMenu = () => {
    setPlayerMenuOpen(false);
    setRateSubmenuOpen(false);
  };

  const changePlaybackRate = (rate: number) => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = rate;
    setPlaybackRate(rate);
    closePlayerMenu();
  };

  // Force un vrai téléchargement du fichier audio (au lieu de l'ouvrir dans
  // un onglet), via un blob local et un lien <a download> synthétique.
  const downloadAudio = async () => {
    if (downloadingAudio) return;
    closePlayerMenu();
    setDownloadingAudio(true);
    try {
      // En ligne : on passe par le flux même-origine (?stream=1) pour éviter le
      // CORS de l'Object Storage (l'URL présignée S3 n'expose pas les en-têtes
      // CORS). Hors-ligne : on a déjà un blob local (pinnedAudioUrl).
      const src = pinnedAudioUrl ?? `/api/recordings/${id}/audio?stream=1`;
      const res = await fetch(src);
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = recording?.filename ?? `enregistrement-${id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Téléchargement impossible',
      );
    } finally {
      setDownloadingAudio(false);
    }
  };

  // Ferme le menu du lecteur au clic en dehors.
  useEffect(() => {
    if (!playerMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!playerMenuRef.current?.contains(e.target as Node)) {
        closePlayerMenu();
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [playerMenuOpen]);

  // Seek sans déclencher la lecture (utilisé par le slider de section).
  const scrubTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
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

  const addEntry = (type: 'discussion' | 'music') => {
    // Préremplie au timecode courant du lecteur.
    setDraftEntry(
      type === 'music'
        ? { timecodeSec: Math.floor(currentTime), type: 'music' }
        : { timecodeSec: Math.floor(currentTime), type: 'discussion', text: '' },
    );
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
    <div className={recording ? 'pb-40' : undefined}>
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
                  className="cursor-pointer text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline disabled:opacity-40"
                >
                  Renommer
                </button>
                <button
                  onClick={() => void askDelete()}
                  disabled={!online}
                  className="cursor-pointer text-zinc-500 underline-offset-2 hover:text-red-400 hover:underline disabled:opacity-40"
                >
                  Supprimer
                </button>
              </div>
              <div className="mt-3">
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
                {timeline && <p className="mt-4 text-xs text-zinc-600">
                  Timeline générée automatiquement le{' '}
                  {new Date(timeline.generatedAt).toLocaleString('fr-FR')}
                  {timeline.editedAt && (
                    <>
                      {' '}
                      · corrigée le{' '}
                      {new Date(timeline.editedAt).toLocaleString('fr-FR')}
                    </>
                  )}
                </p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => {
                      setActionError(null);
                      setConfirmingAnalyze(true);
                    }}
                    disabled={!online || analysisInProgress}
                    className={`rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40${analysisInProgress && analysis?.status !== 'done' ? '' : ' cursor-pointer'}`}
                    title={online ? undefined : 'Indisponible hors-ligne'}
                  >
                    {analysisInProgress
                      ? 'Analyse en cours…'
                      : analysis?.status === 'done'
                        ? 'Relancer l’analyse'
                        : 'Lancer l’analyse'}
                  </button>
                  {pinned ? (
                    <span className="inline-flex overflow-hidden rounded-lg border border-emerald-500/40">
                      <span className="bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-400">
                        ✓ Téléchargé
                      </span>
                      <button
                        onClick={() => setConfirmingUnpin(true)}
                        title="Effacer de cet appareil"
                        aria-label="Effacer de cet appareil"
                        className="flex items-center border-l border-emerald-500/40 px-2.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => void downloadPin()}
                      disabled={pinBusy || !online}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Pour écouter et relire la timeline même sans réseau (au studio)"
                    >
                      {pinBusy ? 'Téléchargement…' : 'Télécharger sur cet appareil'}
                    </button>
                  )}
                </div>
                {actionError && (
                  <p className="mt-2 text-sm text-red-400">{actionError}</p>
                )}
              </div>
            </>
          )}
          {fromPin && (
            <p className="mt-1 text-xs text-amber-400">
              Version téléchargée sur cet appareil (mode hors-ligne)
            </p>
          )}

          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
            <div className="mx-auto max-w-3xl px-4 py-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {audioSrc ? (
                <div>
                  <audio
                    ref={audioRef}
                    preload="metadata"
                    src={audioSrc}
                    className="hidden"
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onLoadedMetadata={(e) => {
                      const d = e.currentTarget.duration;
                      setDuration(Number.isFinite(d) ? d : null);
                      e.currentTarget.playbackRate = playbackRate;
                    }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                  <div className="relative mb-1 flex items-center justify-center gap-6">
                    <button
                      onClick={() => skip(-10)}
                      className="shrink-0 rounded-full p-2 text-zinc-300 hover:bg-zinc-800"
                      title="Reculer de 10 secondes"
                    >
                      <SkipTenIcon direction="back" />
                    </button>
                    <button
                      onClick={togglePlay}
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-zinc-950 hover:bg-zinc-200"
                      title={isPlaying ? 'Mettre en pause' : 'Lire'}
                    >
                      {isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <button
                      onClick={() => skip(10)}
                      className="shrink-0 rounded-full p-2 text-zinc-300 hover:bg-zinc-800"
                      title="Avancer de 10 secondes"
                    >
                      <SkipTenIcon direction="forward" />
                    </button>
                    <div ref={playerMenuRef} className="absolute right-0 top-1/2 -translate-y-1/2">
                      <button
                        onClick={() =>
                          playerMenuOpen ? closePlayerMenu() : setPlayerMenuOpen(true)
                        }
                        className="rounded-full p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                        title="Plus d'options"
                        aria-label="Plus d'options"
                      >
                        <DotsIcon />
                      </button>
                      {playerMenuOpen && (
                        <div className="absolute bottom-full right-0 mb-2 w-52 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-lg">
                          {rateSubmenuOpen ? (
                            <>
                              <button
                                onClick={() => setRateSubmenuOpen(false)}
                                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-zinc-400 hover:bg-zinc-800"
                              >
                                <span>←</span>
                                <span>Vitesse de lecture</span>
                              </button>
                              <div className="my-1 border-t border-zinc-800" />
                              {PLAYBACK_RATES.map((rate) => (
                                <button
                                  key={rate}
                                  onClick={() => changePlaybackRate(rate)}
                                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-zinc-800 ${rate === playbackRate ? 'text-amber-400' : 'text-zinc-200'
                                    }`}
                                >
                                  <span>{`${rate}x`}</span>
                                  {rate === playbackRate && <span>✓</span>}
                                </button>
                              ))}
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => void downloadAudio()}
                                disabled={downloadingAudio}
                                className="block w-full px-3 py-2 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                              >
                                {downloadingAudio ? 'Téléchargement…' : 'Télécharger'}
                              </button>
                              <button
                                onClick={() => setRateSubmenuOpen(true)}
                                className="flex w-full items-center justify-between px-3 py-2 text-left text-zinc-200 hover:bg-zinc-800"
                              >
                                <span>Vitesse de lecture</span>
                                <span className="text-zinc-500">
                                  {`${playbackRate}x`} ›
                                </span>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={duration ?? 0}
                    step={0.1}
                    value={Math.min(currentTime, duration ?? currentTime)}
                    onChange={(e) => scrubTo(Number(e.target.value))}
                    disabled={!duration}
                    className="h-1 w-full cursor-pointer accent-amber-400 disabled:cursor-default"
                    aria-label="Position dans la lecture"
                  />
                  <div className="mt-1 flex items-center justify-between text-xs tabular-nums text-zinc-500">
                    <span>{formatTimecode(currentTime)}</span>
                    <span>{duration != null ? formatTimecode(duration) : '--:--'}</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">
                  Audio indisponible hors-ligne — appuie sur « Télécharger sur cet
                  appareil » quand tu as du réseau.
                </p>
              )}
            </div>
          </div>

          <section className="mt-5">
            {entries && timeline && (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                    Timeline
                  </h2>
                  <div className="flex items-center gap-2">
                    {editMode && (
                      <>
                        <button
                          onClick={() => addEntry('discussion')}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          + Discussion
                        </button>
                        <button
                          onClick={() => addEntry('music')}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-violet-400 hover:bg-zinc-800"
                        >
                          + ♪ Musique
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => void toggleEditMode()}
                      disabled={!online && !editMode}
                      className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${editMode
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
                        isLast={i === entries.length - 1}
                        sectionEnd={
                          entries[i + 1]?.timecodeSec ??
                          (entry.type === 'music' ? entry.endSec : undefined) ??
                          (duration != null ? Math.floor(duration) : undefined)
                        }
                        progressTime={currentTime}
                        onSeek={seekTo}
                        onScrub={scrubTo}
                        onEdit={editMode ? () => setEditingIndex(i) : undefined}
                      />
                    ),
                  )}
                </ol>
              </>
            )}
          </section>
        </>
      )}

      {confirmingAnalyze && (
        <ConfirmDialog
          title={
            analysis?.status === 'done'
              ? 'Relancer l’analyse ?'
              : 'Lancer l’analyse ?'
          }
          message={
            analysis?.status === 'done'
              ? `La timeline sera entièrement régénérée et remplacée — y compris les corrections faites à la main.${detail?.transcriptionCached
                ? ' La transcription est déjà en mémoire : c’est l’affaire d’une minute ou deux.'
                : ''
              }`
              : 'L’enregistrement va être transcrit puis résumé en une timeline chronologique : discussions résumées et passages joués, avec timecodes cliquables. Compte quelques minutes pour une répète d’une heure — la page se mettra à jour toute seule.'
          }
          confirmLabel={analysis?.status === 'done' ? 'Relancer' : 'Lancer'}
          busyLabel="Lancement…"
          tone="primary"
          onConfirm={async () => {
            if (!(await ensureAuth())) {
              setConfirmingAnalyze(false);
              return;
            }
            await api.post(`/api/recordings/${id}/analyze`);
            setConfirmingAnalyze(false);
            void load();
          }}
          onCancel={() => setConfirmingAnalyze(false)}
        />
      )}

      {confirmingUnpin && (
        <ConfirmDialog
          title="Effacer de cet appareil ?"
          message="L’audio et la timeline téléchargés seront effacés du stockage de cet appareil. L’enregistrement reste bien sûr disponible en ligne."
          confirmLabel="Effacer"
          busyLabel="Effacement…"
          onConfirm={async () => {
            await unpinRecording(id);
            setPinned(false);
            setPinnedAudioUrl(null);
            setConfirmingUnpin(false);
          }}
          onCancel={() => setConfirmingUnpin(false)}
        />
      )}

      {confirmingDelete && recording && (
        <ConfirmDialog
          title={`Supprimer « ${recording.filename} » ?`}
          message="L'enregistrement et son analyse seront supprimés. Le fichier audio sera mis à la corbeille du Drive du groupe."
          confirmLabel="Supprimer"
          busyLabel="Suppression…"
          onConfirm={async () => {
            await api.delete(`/api/recordings/${id}`);
            await unpinRecording(id).catch(() => { });
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
  isLast,
  sectionEnd,
  progressTime,
  onSeek,
  onScrub,
  onEdit,
}: {
  entry: TimelineEntry;
  active: boolean;
  isLast: boolean;
  sectionEnd?: number;
  progressTime: number;
  onSeek: (seconds: number) => void;
  onScrub: (seconds: number) => void;
  onEdit?: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active]);

  const isMusic = entry.type === 'music';
  const showSlider =
    active && sectionEnd != null && sectionEnd > entry.timecodeSec + 1;

  return (
    <li ref={ref} className={`cursor-pointer rounded-lg ${active
      ? 'bg-amber-400/10 ring-1 ring-amber-400/40'
      : 'hover:bg-zinc-900'
      }`}>
      <div className="flex items-start gap-1">
        <button
          onClick={() => onSeek(entry.timecodeSec)}
          className={`cursor-pointer flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left transition-colors ${showSlider ? 'rounded-b-none' : ''}`}
        >
          <span
            className={`shrink-0 font-mono text-xs tabular-nums ${active ? 'text-amber-400' : 'text-zinc-500'
              }`}
          >
            {formatTimecode(entry.timecodeSec)}
          </span>
          {isMusic ? (
            <span className="text-sm font-medium tracking-wide text-violet-400">
              ♪ [MUSIQUE]
              {entry.text && (
                <span className="ml-2 font-normal text-violet-300">
                  {entry.text}
                </span>
              )}
              {/* En dernière ligne, rien ne borne la section : la fin détectée
                  redevient une info utile. */}
              {isLast && entry.endSec != null && (
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
            className="mt-1.5 mr-1.5 shrink-0 rounded-md border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            title="Corriger cette ligne"
          >
            ✎
          </button>
        )}
      </div>
      {showSlider && (
        <div
          className={`flex items-center gap-2 px-3 pb-2 ${onEdit ? 'mr-7' : ''
            }`}
        >
          <input
            type="range"
            min={entry.timecodeSec}
            max={sectionEnd}
            step={1}
            value={Math.min(Math.max(progressTime, entry.timecodeSec), sectionEnd)}
            onChange={(e) => onScrub(Number(e.target.value))}
            className="h-1 w-full cursor-pointer accent-amber-400"
            aria-label="Position dans cette section"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
            {formatTimecode(sectionEnd)}
          </span>
        </div>
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
      // endSec n'est plus affiché ni éditable, mais on le conserve tel quel :
      // il sert en interne au slider de section (dernière ligne de la timeline).
      const endSec =
        entry.endSec != null && entry.endSec >= timecodeSec
          ? entry.endSec
          : undefined;
      updated = {
        timecodeSec,
        type: 'music',
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(endSec != null ? { endSec } : {}),
      };
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
        {isMusic && <span className="text-sm text-violet-400">♪ [MUSIQUE]</span>}
      </div>
      {isMusic ? (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Libellé (optionnel, ex. refrain idée 2)"
          className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-400"
        />
      ) : (
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
