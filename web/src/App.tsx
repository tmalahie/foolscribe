import { Link, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { RecordingPage } from './pages/RecordingPage';
import { RehearsalPage } from './pages/RehearsalPage';
import { RehearsalsPage } from './pages/RehearsalsPage';
import { useOnline } from './useOnline';

export function App() {
  const { email, logout } = useAuth();
  const online = useOnline();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-bold tracking-tight">
            fool<span className="text-amber-400">scribe</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            {!online && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400">
                hors-ligne
              </span>
            )}
            {email && (
              <>
                <span className="hidden text-zinc-400 sm:inline">{email}</span>
                <button
                  onClick={() => void logout()}
                  className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
                >
                  Déconnexion
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Routes>
          <Route path="/" element={<RehearsalsPage />} />
          <Route path="/rehearsals/:id" element={<RehearsalPage />} />
          <Route path="/recordings/:id" element={<RecordingPage />} />
        </Routes>
      </main>
    </div>
  );
}
