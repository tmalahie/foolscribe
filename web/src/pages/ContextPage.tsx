import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';

const PLACEHOLDER = `Ex. :
Morceaux :
- Caipi : …
- Idée 2 (« l'idée deux ») : morceau en chantier, distinct de Caipi
Vocabulaire :
- « le mystère » = le passage calme après le 2e refrain`;

/**
 * Contexte du groupe : notes durables lues par l'analyse et le chat (noms de
 * morceaux, numérotation des idées, vocabulaire). Le chat le complète quand on
 * lui corrige quelque chose de durable.
 */
export function ContextPage() {
  const { email, ensureAuth } = useAuth();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [maxChars, setMaxChars] = useState(8000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!(await ensureAuth())) {
        setError('Connexion requise pour voir le contexte du groupe.');
        return;
      }
      try {
        const data = await api.get<{ content: string; maxChars: number }>('/api/context');
        setContent(data.content);
        setSaved(data.content);
        setMaxChars(data.maxChars);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Contexte inaccessible');
      }
    })();
  }, [ensureAuth, email]);

  const save = async () => {
    if (content == null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.put<{ content: string }>('/api/context', { content });
      setContent(data.content);
      setSaved(data.content);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← Retour
      </Link>
      <h1 className="mt-2 text-xl font-semibold">Contexte du groupe</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Notes lues par l’analyse et par le chat : noms des morceaux, idées en chantier,
        vocabulaire du groupe… Le chat les complète quand tu lui corriges quelque chose
        de durable. Elles servent aux prochaines analyses (relancer une analyse pour en
        profiter sur un ancien enregistrement).
      </p>
      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      {content != null && (
        <>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={maxChars}
            rows={16}
            placeholder={PLACEHOLDER}
            className="mt-4 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {content.length} / {maxChars}
            </span>
            <button
              onClick={() => void save()}
              disabled={busy || content === saved}
              className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
            >
              {busy ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
