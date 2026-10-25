import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, parseTimecode } from '../api';
import type { ChatMessage, PendingChatTurn } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

const POLL_MS = 2000;

const EXAMPLES = [
  'Quand est-ce qu’on a parlé du refrain ?',
  'Qu’est-ce qu’on a décidé pour la fin ?',
  'Les passages après 37:00, c’est l’idée 2, pas Caipi',
];

function authorName(email: string | null): string {
  return email ? email.split('@')[0] : '';
}

/** Timecodes M:SS / H:MM:SS cliquables, **gras** conservé. */
function renderInline(text: string, onSeek: (sec: number) => void): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\b\d{1,2}:\d{2}(?::\d{2})?\b)/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={i} className="font-semibold text-zinc-100">
          {renderInline(part.slice(2, -2), onSeek)}
        </strong>
      );
    }
    const seconds = /^\d{1,2}:\d{2}(?::\d{2})?$/.test(part) ? parseTimecode(part) : null;
    if (seconds != null) {
      return (
        <button
          key={i}
          onClick={() => onSeek(seconds)}
          className="font-mono text-amber-400 underline-offset-2 hover:underline"
        >
          {part}
        </button>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function MessageText({ text, onSeek }: { text: string; onSeek: (sec: number) => void }) {
  return (
    <div className="space-y-1">
      {text.split('\n').map((line, i) => {
        if (!line.trim()) return <div key={i} className="h-1" />;
        const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
        return bullet ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-zinc-500">•</span>
            <span>{renderInline(bullet[1], onSeek)}</span>
          </div>
        ) : (
          <p key={i}>{renderInline(line, onSeek)}</p>
        );
      })}
    </div>
  );
}

/**
 * Chat sur l'enregistrement : questions sur la répète et corrections de la
 * timeline / de la transcription. Conversation partagée par le groupe.
 */
export function ChatPanel({
  recordingId,
  onSeek,
  onChanged,
  onClose,
}: {
  recordingId: number;
  onSeek: (seconds: number) => void;
  /** Appelé quand un tour se termine (la timeline a pu changer). */
  onChanged: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [pending, setPending] = useState<PendingChatTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{
        messages: ChatMessage[];
        pending: PendingChatTurn | null;
      }>(`/api/recordings/${recordingId}/chat`);
      setMessages(data.messages);
      setPending(data.pending);
      setError(null);
      const running = !!data.pending && !data.pending.error;
      if (wasRunning.current && !running) onChanged();
      wasRunning.current = running;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Chat inaccessible (hors-ligne ?)');
    }
  }, [recordingId, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = !!pending && !pending.error;
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(interval);
  }, [running, load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async (text: string) => {
    if (!text.trim() || sending || running) return;
    setSending(true);
    setError(null);
    try {
      const data = await api.post<{ pending: PendingChatTurn }>(
        `/api/recordings/${recordingId}/chat`,
        { message: text.trim() },
      );
      setPending(data.pending);
      wasRunning.current = true;
      setDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Envoi impossible');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex h-full w-full flex-col border-l border-zinc-800 bg-zinc-950 sm:w-[28rem]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-200">Chat sur l’enregistrement</h2>
          <div className="flex items-center gap-3">
            {!!messages?.length && (
              <button
                onClick={() => setConfirmingClear(true)}
                disabled={running}
                className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                Effacer
              </button>
            )}
            <button
              onClick={onClose}
              className="text-lg leading-none text-zinc-400 hover:text-zinc-200"
              aria-label="Fermer"
            >
              ×
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
          {messages && !messages.length && !pending && (
            <div className="space-y-3 text-zinc-400">
              <p>
                Pose une question sur la répète ou demande une correction de la timeline. La
                conversation est partagée avec le groupe.
              </p>
              <div className="flex flex-col items-start gap-2">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    onClick={() => setDraft(example)}
                    className="rounded-lg border border-zinc-800 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages?.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex flex-col items-end">
                <span className="mb-0.5 text-[11px] text-zinc-500">{authorName(m.authorEmail)}</span>
                <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-tr-sm bg-zinc-800 px-3 py-2 text-zinc-100">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={m.id} className="text-zinc-300">
                <MessageText text={m.content} onSeek={onSeek} />
                {m.actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.actions.map((a, i) =>
                      a.type === 'context' ? (
                        <Link
                          key={i}
                          to="/context"
                          className="rounded-full border border-violet-400/40 bg-violet-400/10 px-2 py-0.5 text-[11px] text-violet-300 hover:bg-violet-400/20"
                        >
                          ✎ {a.summary}
                        </Link>
                      ) : (
                        <span
                          key={i}
                          className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300"
                        >
                          ✎ {a.summary}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>
            ),
          )}

          {pending && (
            <>
              <div className="flex flex-col items-end">
                <span className="mb-0.5 text-[11px] text-zinc-500">{authorName(pending.authorEmail)}</span>
                <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-tr-sm bg-zinc-800 px-3 py-2 text-zinc-100">
                  {pending.content}
                </div>
              </div>
              {pending.error ? (
                <p className="text-red-400">{pending.error}</p>
              ) : (
                <p className="animate-pulse text-zinc-500">
                  Réflexion… (la première question peut prendre une à deux minutes)
                </p>
              )}
            </>
          )}
        </div>

        <form
          className="border-t border-zinc-800 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={2}
              placeholder="Quand est-ce qu’on a parlé de…"
              className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending || running}
              className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-300 disabled:opacity-40"
            >
              Envoyer
            </button>
          </div>
        </form>
      </div>

      {confirmingClear && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            title="Effacer la conversation ?"
            message="Les messages du chat de cet enregistrement seront effacés pour tout le groupe. Les corrections déjà faites (timeline, transcription) restent."
            confirmLabel="Effacer"
            busyLabel="Effacement…"
            onConfirm={async () => {
              await api.delete(`/api/recordings/${recordingId}/chat`);
              setConfirmingClear(false);
              await load();
            }}
            onCancel={() => setConfirmingClear(false)}
          />
        </div>
      )}
    </div>
  );
}
