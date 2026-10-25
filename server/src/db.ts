import type { RowDataPacket } from 'mysql2';
import mysql from 'mysql2/promise';
import { config } from './config';

export const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  user: config.mysql.user,
  password: config.mysql.password,
  connectionLimit: 10,
  charset: 'utf8mb4',
  // Les DATE sortent en 'YYYY-MM-DD' (pas en Date UTC minuit local, qui
  // décale d'un jour à la sérialisation JSON).
  dateStrings: ['DATE'],
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rehearsals (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    date            DATE NULL,
    drive_folder_id VARCHAR(128) NULL UNIQUE,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS recordings (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    rehearsal_id  INT NOT NULL,
    filename      VARCHAR(512) NOT NULL,
    drive_file_id VARCHAR(128) NULL UNIQUE,
    duration_sec  INT NULL,
    size_bytes    BIGINT NULL,
    object_key    VARCHAR(512) NULL,
    mirrored_at   DATETIME NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_recordings_rehearsal FOREIGN KEY (rehearsal_id)
      REFERENCES rehearsals(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS transcriptions (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    recording_id INT NOT NULL UNIQUE,
    words_json   LONGTEXT NOT NULL,
    language     VARCHAR(16) NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_transcriptions_recording FOREIGN KEY (recording_id)
      REFERENCES recordings(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS analyses (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    recording_id    INT NOT NULL,
    status          ENUM('pending','running','done','error') NOT NULL DEFAULT 'pending',
    timeline_json   LONGTEXT NULL,
    reasoning_model VARCHAR(64) NULL,
    error           TEXT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_analyses_recording FOREIGN KEY (recording_id)
      REFERENCES recordings(id) ON DELETE CASCADE,
    INDEX idx_analyses_recording (recording_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Conversation du chat d'un enregistrement, partagée par tout le groupe.
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    recording_id INT NOT NULL,
    role         ENUM('user','assistant') NOT NULL,
    content      MEDIUMTEXT NOT NULL,
    actions_json TEXT NULL,
    author_email VARCHAR(255) NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_messages_recording FOREIGN KEY (recording_id)
      REFERENCES recordings(id) ON DELETE CASCADE,
    INDEX idx_chat_messages_recording (recording_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Réglages globaux clé/valeur (contexte du groupe…).
  `CREATE TABLE IF NOT EXISTS settings (
    name       VARCHAR(64) PRIMARY KEY,
    value      MEDIUMTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// Colonnes ajoutées après coup à des tables existantes (MySQL n'a pas de
// ADD COLUMN IF NOT EXISTS).
const ADDED_COLUMNS = [
  {
    table: 'transcriptions',
    column: 'original_words_json',
    // Sortie Scribe d'origine, sauvegardée à la première correction manuelle.
    definition: 'LONGTEXT NULL',
  },
];

export async function initDb(): Promise<void> {
  for (const statement of SCHEMA) {
    await pool.query(statement);
  }
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (rows.length === 0) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
