import { useEffect, useRef, useState } from 'react';
import { shareLink } from '../share';

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="5" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="M8.4 13.4l7.2 4.2M15.6 6.4l-7.2 4.2" />
    </svg>
  );
}

/**
 * Partage l'URL courante — indispensable dans la PWA installée, qui n'affiche
 * aucune barre d'adresse d'où copier le lien.
 */
export function ShareButton({
  url,
  title,
  label = 'Partager cette page',
}: {
  url: string;
  title?: string;
  label?: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = (message: string) => {
    setNotice(message);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), 2000);
  };

  const share = async () => {
    try {
      const outcome = await shareLink(url, title);
      if (outcome === 'copied') flash('Lien copié');
    } catch {
      flash('Partage impossible');
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      {notice && <span className="text-xs text-zinc-400">{notice}</span>}
      <button
        onClick={() => void share()}
        title={label}
        aria-label={label}
        className="cursor-pointer rounded-full p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <ShareIcon />
      </button>
    </div>
  );
}
