import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import { config } from './config';

// OVH Object Storage, S3-compatible. L'audio est servi au navigateur via des
// URLs présignées (Range natif, zéro bande passante serveur — §7 du plan).
const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
  forcePathStyle: true,
});

const PRESIGN_EXPIRY_SEC = 3600;

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
};

export function audioMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export async function uploadStream(
  key: string,
  body: Readable | Buffer,
  contentType: string,
): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
  });
  await upload.done();
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }),
  );
}

export async function presignGetUrl(key: string): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: PRESIGN_EXPIRY_SEC },
  );
}

export interface ObjectStream {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  statusCode: 200 | 206;
}

/**
 * Flux de l'objet à travers le serveur (avec Range) — utilisé uniquement par le
 * téléchargement « disponible hors-ligne » du front, pour éviter les soucis de
 * CORS d'un fetch() cross-origin vers l'Object Storage.
 */
export async function getObjectStream(
  key: string,
  range?: string,
): Promise<ObjectStream> {
  const { Body, ContentType, ContentLength, ContentRange } = await s3.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Range: range,
    }),
  );
  return {
    body: Body as Readable,
    contentType: ContentType,
    contentLength: ContentLength,
    contentRange: ContentRange,
    statusCode: range ? 206 : 200,
  };
}
