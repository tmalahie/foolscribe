import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';

// La lecture est publique : le login Google n'est proposé qu'au moment d'une
// action d'écriture (§8 du plan). ensureAuth() ouvre la modale si besoin et
// résout quand l'utilisateur est connecté (ou a refermé la modale).

interface GsiButtonConfig {
  theme?: string;
  size?: string;
  text?: string;
  locale?: string;
  width?: number;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }): void;
          renderButton(el: HTMLElement, config: GsiButtonConfig): void;
        };
      };
    };
  }
}

interface AuthContextValue {
  email: string | null;
  ensureAuth: () => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  email: null,
  ensureAuth: async () => false,
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

let gsiScriptPromise: Promise<void> | null = null;
function loadGsiScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiScriptPromise) {
    gsiScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Impossible de charger Google Sign-In'));
      document.head.appendChild(script);
    });
  }
  return gsiScriptPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const pendingResolvers = useRef<((ok: boolean) => void)[]>([]);

  useEffect(() => {
    api
      .get<{ email: string | null }>('/api/auth/me')
      .then((data) => setEmail(data.email))
      .catch(() => {});
  }, []);

  const settle = useCallback((ok: boolean) => {
    for (const resolve of pendingResolvers.current) resolve(ok);
    pendingResolvers.current = [];
    setModalOpen(false);
  }, []);

  const ensureAuth = useCallback(async (): Promise<boolean> => {
    if (email) return true;
    // Session peut-être posée dans un autre onglet : on revérifie.
    try {
      const me = await api.get<{ email: string | null }>('/api/auth/me');
      if (me.email) {
        setEmail(me.email);
        return true;
      }
    } catch {
      // hors-ligne ou serveur injoignable : la modale l'expliquera
    }
    setError(null);
    setModalOpen(true);
    return new Promise((resolve) => {
      pendingResolvers.current.push(resolve);
    });
  }, [email]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setEmail(null);
  }, []);

  // Monte le bouton Google quand la modale s'ouvre.
  useEffect(() => {
    if (!modalOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ googleClientId }] = await Promise.all([
          api.get<{ googleClientId: string }>('/api/config'),
          loadGsiScript(),
        ]);
        if (cancelled || !buttonRef.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async ({ credential }) => {
            try {
              const data = await api.post<{ email: string }>(
                '/api/auth/google',
                { credential },
              );
              setEmail(data.email);
              settle(true);
            } catch (err) {
              setError(
                err instanceof ApiError
                  ? err.message
                  : 'Connexion impossible, réessaie.',
              );
            }
          },
        });
        buttonRef.current.replaceChildren();
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'filled_black',
          size: 'large',
          text: 'signin_with',
          locale: 'fr',
        });
      } catch {
        if (!cancelled) {
          setError(
            'Google Sign-In n’a pas pu se charger (hors-ligne ?). Réessaie plus tard.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modalOpen, settle]);

  return (
    <AuthContext.Provider value={{ email, ensureAuth, logout }}>
      {children}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => settle(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-zinc-100">Connexion requise</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Cette action est réservée aux membres du groupe. Connecte-toi avec
              ton compte Google.
            </p>
            <div ref={buttonRef} className="mt-4 flex justify-center" />
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <button
              className="mt-4 w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              onClick={() => settle(false)}
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}
