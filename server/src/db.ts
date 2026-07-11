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
];

export async function initDb(): Promise<void> {
  for (const statement of SCHEMA) {
    await pool.query(statement);
  }
}
