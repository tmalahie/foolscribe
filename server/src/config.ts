import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Le .env vit à la racine du repo ; le serveur peut être lancé depuis la racine
// (npm workspaces) ou depuis server/.
for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  isProduction: process.env.NODE_ENV === 'production',

  mysql: {
    host: required('MYSQL_HOST'),
    port: parseInt(process.env.MYSQL_PORT ?? '3306', 10),
    database: required('MYSQL_DATABASE'),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
  },

  s3: {
    endpoint: required('S3_ENDPOINT'),
    region: required('S3_REGION'),
    bucket: required('S3_BUCKET'),
    accessKey: required('S3_ACCESS_KEY'),
    secretKey: required('S3_SECRET_KEY'),
  },

  google: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    // Peut être vide tant que le script get-refresh-token n'a pas été lancé ;
    // les routes qui touchent Drive renvoient alors une 503 explicite.
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '',
    driveRootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? '',
  },

  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

  jwtSecret: required('JWT_SECRET'),
  allowedEmails: required('ALLOWED_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};
