import { google, drive_v3 } from 'googleapis';
import type { Readable } from 'stream';
import { config } from './config';
import { HttpError } from './errors';

// Une seule identité backend : le refresh token OAuth du compte Google du
// groupe. Le login Google des membres ne sert qu'à l'autorisation (§7 du plan).
let driveClient: drive_v3.Drive | null = null;

function getDrive(): drive_v3.Drive {
  if (!config.google.refreshToken) {
    throw new HttpError(
      503,
      'Google Drive non configuré : lancer `npm run get-refresh-token` et renseigner GOOGLE_OAUTH_REFRESH_TOKEN dans le .env',
    );
  }
  if (!driveClient) {
    const auth = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
    );
    auth.setCredentials({ refresh_token: config.google.refreshToken });
    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

export interface DriveFolder {
  id: string;
  name: string;
  createdTime: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  createdTime: string;
}

const AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.wav',
  '.aac',
  '.ogg',
  '.opus',
  '.flac',
  '.aiff',
  '.wma',
  '.mp4',
];

export function looksLikeAudio(file: { name: string; mimeType: string }): boolean {
  if (file.mimeType.startsWith('audio/')) return true;
  const lower = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function listChildFolders(parentId: string): Promise<DriveFolder[]> {
  const drive = getDrive();
  const folders: DriveFolder[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name, createdTime)',
      pageSize: 1000,
      pageToken,
    });
    for (const f of data.files ?? []) {
      if (f.id && f.name) {
        folders.push({ id: f.id, name: f.name, createdTime: f.createdTime ?? '' });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return folders;
}

export async function listFiles(folderId: string): Promise<DriveFile[]> {
  const drive = getDrive();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, createdTime)',
      pageSize: 1000,
      pageToken,
    });
    for (const f of data.files ?? []) {
      if (f.id && f.name) {
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? '',
          sizeBytes: f.size != null ? parseInt(f.size, 10) : null,
          createdTime: f.createdTime ?? '',
        });
      }
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

export async function createFolder(name: string): Promise<string> {
  const drive = getDrive();
  const { data } = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [config.google.driveRootFolderId],
    },
    fields: 'id',
  });
  if (!data.id) throw new Error('Création du dossier Drive : pas d\'id renvoyé');
  return data.id;
}

export async function uploadFile(
  folderId: string,
  name: string,
  mimeType: string,
  body: Readable,
): Promise<{ id: string; sizeBytes: number | null }> {
  const drive = getDrive();
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body },
    fields: 'id, size',
  });
  if (!data.id) throw new Error('Upload Drive : pas d\'id renvoyé');
  return {
    id: data.id,
    sizeBytes: data.size != null ? parseInt(data.size, 10) : null,
  };
}

export async function downloadFile(fileId: string): Promise<Readable> {
  const drive = getDrive();
  const { data } = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );
  return data as Readable;
}
