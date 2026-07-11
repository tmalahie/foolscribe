import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate } from '../api';
import { useAuth } from '../auth';
import type { Rehearsal } from '../types';
import { useOnline } from '../useOnline';

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Nom proposé selon la convention du groupe : « Répète du 24/9/25 ». */
function rehearsalNameForDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return '';
  return `Répète du ${day}/${month}/${String(year).slice(2)}`;
}

export function RehearsalsPage() {
  const { ensureAuth } = useAuth();
  const online = useOnline();
  const [rehearsals, setRehearsals] = useState<Rehearsal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ rehearsals: Rehearsal[] }>('/api/rehearsals')
      .then((data) => {
        setRehearsals(data.rehearsals);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Impossible de charger les répétitions (hors-ligne ?)',
        );
      });
  }, []);

  useEffect(load, [load]);

  const openCreateForm = () => {
    if (creating) {
      setCreating(false);
      return;
    }
    const today = todayIso();
    setDate(today);
    setName(rehearsalNameForDate(today));
    setNameTouched(false);
    setCreating(true);
  };

  const onDateChange = (value: string) => {
    setDate(value);
    // Le nom suit la date tant qu'il n'a pas été modifié à la main.
    if (!nameTouched && value) {
      setName(rehearsalNameForDate(value));
    }
  };

  const createRehearsal = async () => {
    if (!name.trim() || busy) return;
    if (!(await ensureAuth())) return;
    setBusy(true);
    try {
      await api.post('/api/rehearsals', {
        name: name.trim(),
        date: date || undefined,
      });
      setName('');
      setDate('');
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    if (syncing) return;
    if (!(await ensureAuth())) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api.post<{
        newRehearsals: number;
        newRecordings: number;
      }>('/api/sync');
      setSyncMessage(
        `Synchronisation terminée : ${result.newRehearsals} nouvelle(s) répète(s), ${result.newRecordings} nouveau(x) enregistrement(s).`,
      );
      load();
    } catch (err) {
      setSyncMessage(
        err instanceof ApiError ? err.message : 'Synchronisation impossible',
      );
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Répétitions</h1>
        <div className="flex gap-2">
          <button
            onClick={() => void sync()}
            disabled={!online || syncing}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              online
                ? 'Récupère les répètes et fichiers ajoutés dans le Drive du groupe'
                : 'Indisponible hors-ligne'
            }
          >
            {syncing ? 'Synchronisation…' : 'Synchroniser avec Drive'}
          </button>
          <button
            onClick={openCreateForm}
            disabled={!online}
            className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Nouvelle répète
          </button>
        </div>
      </div>

      {syncMessage && <p className="mt-3 text-sm text-zinc-400">{syncMessage}</p>}

      {creating && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              autoFocus
              type="date"
              value={date}
              onChange={(e) => onDateChange(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-400"
            />
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              onKeyDown={(e) => e.key === 'Enter' && void createRehearsal()}
              placeholder="Nom de la répète"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-400"
            />
            <button
              onClick={() => void createRehearsal()}
              disabled={!name.trim() || busy}
              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
            >
              {busy ? 'Création…' : 'Créer'}
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Crée aussi le dossier correspondant dans le Drive du groupe.
          </p>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {rehearsals === null && !error && (
        <p className="mt-6 text-sm text-zinc-500">Chargement…</p>
      )}

      {rehearsals?.length === 0 && (
        <p className="mt-6 text-sm text-zinc-500">
          Aucune répétition pour l'instant. Crée-en une ou synchronise avec
          Drive.
        </p>
      )}

      <ul className="mt-4 space-y-2">
        {rehearsals?.map((rehearsal) => (
          <li key={rehearsal.id}>
            <Link
              to={`/rehearsals/${rehearsal.id}`}
              className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 transition-colors hover:border-zinc-600"
            >
              <div>
                <div className="font-medium">{rehearsal.name}</div>
                {rehearsal.date && (
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {formatDate(rehearsal.date)}
                  </div>
                )}
              </div>
              <div className="text-sm text-zinc-400">
                {rehearsal.recordings_count ?? 0} enreg.
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
