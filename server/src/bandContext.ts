import { pool } from './db';
import type { RowDataPacket } from 'mysql2';

/**
 * « Contexte du groupe » : notes libres (morceaux en cours et leurs surnoms,
 * vocabulaire, habitudes…) injectées dans les prompts de la pipeline et du
 * chat. Éditable à la main, et par le chat quand un membre corrige quelque
 * chose de durable — jamais automatiquement en fin d'analyse.
 */
const SETTING_NAME = 'band_context';
export const BAND_CONTEXT_MAX_CHARS = 8000;

export async function getBandContext(): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT value FROM settings WHERE name = ?',
    [SETTING_NAME],
  );
  return (rows[0]?.value as string | undefined) ?? '';
}

export async function setBandContext(value: string): Promise<string> {
  const trimmed = value.trim().slice(0, BAND_CONTEXT_MAX_CHARS);
  await pool.query(
    'INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [SETTING_NAME, trimmed],
  );
  return trimmed;
}
