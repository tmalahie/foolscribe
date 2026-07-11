import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatTimecode } from '../api';
import { useAuth } from '../auth';
import {
  getPinnedAudio,
  getPinnedDetail,
  isPinned,
  pinRecording,
  refreshPinnedDetail,
  unpinRecording,
} from '../offline';
import type { RecordingDetail, TimelineEntry } from '../types';
import { useOnline } from '../useOnline';

export function RecordingPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
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
  const audioRef = useRef<HTMLAudioElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<RecordingDetail>(`/api/recordings/${id}`);
      setDetail(data);
      setFromPin(false);
      setError(null);
      // Garde la copie épinglée à jour (nouvelle analyse, etc.).
      void refreshPinnedDetail(id, data);
    } catch (err) {
      // Réseau KO : on retombe sur la version épinglée si elle existe.
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

  // État d'épinglage + URL de l'audio local le cas échéant.
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

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    void audio.play().catch(() => {});
  };

  const entries = detail?.analysis?.timeline?.entries;

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

  // Hors-ligne avec audio épinglé → blob local (indépendant des URLs présignées).
  const audioSrc = pinnedAudioUrl ?? (online ? `/api/recordings/${id}/audio` : null);

  const recording = detail?.recording;
  const analysis = detail?.analysis ?? null;
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
          <h1 className="mt-2 break-words text-xl font-semibold">
            {recording.filename}
          </h1>
          {fromPin && (
            <p className="mt-1 text-xs text-amber-400">
              Version hors-ligne (épinglée)
            </p>
          )}

          <div className="sticky top-[53px] z-30 -mx-4 mt-4 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
            {audioSrc ? (
              <audio
                ref={audioRef}
                controls
                preload="metadata"
                src={audioSrc}
                className="w-full"
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              />
            ) : (
              <p className="text-sm text-zinc-500">
                Audio indisponible hors-ligne — utilise « Disponible hors-ligne »
                quand tu as du réseau.
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
              >
                {pinBusy
                  ? 'Téléchargement…'
                  : pinned
                    ? '✓ Dispo hors-ligne — retirer'
                    : 'Disponible hors-ligne'}
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
                Analyse en cours — transcription puis génération de la timeline.
                La page se met à jour toute seule (compter quelques minutes pour
                une répète d'une heure).
              </div>
            )}

            {!analysis && (
              <p className="text-sm text-zinc-500">
                Pas encore d'analyse pour cet enregistrement.
              </p>
            )}

            {entries && (
              <>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                  Timeline
                </h2>
                <ol className="space-y-1">
                  {entries.map((entry, i) => (
                    <TimelineRow
                      key={i}
                      entry={entry}
                      active={i === activeIndex}
                      onSeek={seekTo}
                    />
                  ))}
                </ol>
                {detail?.analysis?.timeline && (
                  <p className="mt-4 text-xs text-zinc-600">
                    Générée le{' '}
                    {new Date(
                      detail.analysis.timeline.generatedAt,
                    ).toLocaleString('fr-FR')}{' '}
                    · {detail.analysis.timeline.model.stt} +{' '}
                    {detail.analysis.timeline.model.reasoning}
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TimelineRow({
  entry,
  active,
  onSeek,
}: {
  entry: TimelineEntry;
  active: boolean;
  onSeek: (seconds: number) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [active]);

  const isMusic = entry.type === 'music';
  return (
    <li ref={ref}>
      <button
        onClick={() => onSeek(entry.timecodeSec)}
        className={`flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
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
          <span className="text-sm text-zinc-200">
            {entry.speaker && (
              <span className="mr-1.5 font-medium text-zinc-400">
                {entry.speaker} —
              </span>
            )}
            {entry.text}
          </span>
        )}
      </button>
    </li>
  );
}
