export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // corps non JSON
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return fetch(path).then((res) => handle<T>(res));
  },

  post<T>(path: string, body?: unknown): Promise<T> {
    return fetch(path, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((res) => handle<T>(res));
  },

  postForm<T>(path: string, form: FormData): Promise<T> {
    return fetch(path, { method: 'POST', body: form }).then((res) =>
      handle<T>(res),
    );
  },

  patch<T>(path: string, body: unknown): Promise<T> {
    return fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => handle<T>(res));
  },

  put<T>(path: string, body: unknown): Promise<T> {
    return fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => handle<T>(res));
  },

  delete<T>(path: string): Promise<T> {
    return fetch(path, { method: 'DELETE' }).then((res) => handle<T>(res));
  },
};

/** Parse "m:ss", "h:mm:ss" ou un nombre de secondes ; null si invalide. */
export function parseTimecode(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, h, m, s] = match;
  const seconds =
    (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

export function formatTimecode(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
