export type ShareOutcome = 'shared' | 'copied';

/**
 * Partage un lien : feuille de partage native quand le navigateur la propose
 * (le cas dans la PWA, où il n'y a pas de barre d'adresse), presse-papiers
 * sinon. `null` si l'utilisateur a annulé le partage.
 *
 * À appeler directement depuis un gestionnaire de clic : Safari refuse
 * `navigator.share` s'il n'est pas déclenché par un geste utilisateur.
 */
export async function shareLink(
  url: string,
  title?: string,
): Promise<ShareOutcome | null> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share(title ? { title, url } : { url });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      // Refus du navigateur (contexte non sécurisé, permission…) : presse-papiers.
    }
  }
  await copyToClipboard(url);
  return 'copied';
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Repli pour les contextes sans Clipboard API (http, vieux Safari).
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Copie du lien impossible');
}
