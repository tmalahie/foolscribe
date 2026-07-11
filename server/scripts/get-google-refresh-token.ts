/**
 * Script one-shot : génère le GOOGLE_OAUTH_REFRESH_TOKEN du compte Google du
 * groupe (identité backend unique pour Drive, §7 du plan).
 *
 * Usage :
 *   npm run get-refresh-token          (depuis la racine du repo)
 *
 * Puis ouvrir l'URL affichée AVEC LE COMPTE GOOGLE DU GROUPE, autoriser, et
 * coller le refresh token affiché dans le .env.
 *
 * Prérequis côté Google Cloud Console (client OAuth GOOGLE_OAUTH_CLIENT_ID) :
 *   - type « Application Web » : ajouter http://localhost:53682/oauth2callback
 *     aux « URI de redirection autorisés » ;
 *   - type « Ordinateur de bureau » : rien à faire (loopback autorisé d'office).
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { google } from 'googleapis';

for (const candidate of [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    'GOOGLE_OAUTH_CLIENT_ID et GOOGLE_OAUTH_CLIENT_SECRET doivent être renseignés dans le .env',
  );
  process.exit(1);
}

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // indispensable pour obtenir un refresh token
  prompt: 'consent', // force la réémission d'un refresh token même si déjà accordé
  scope: ['https://www.googleapis.com/auth/drive'],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Paramètre code manquant');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h1>foolscribe</h1><p>Refresh token généré — retourne dans le terminal, tu peux fermer cet onglet.</p>',
    );
    if (!tokens.refresh_token) {
      console.error(
        '\nPas de refresh_token dans la réponse (le compte avait déjà un accès actif ?).\n' +
          'Révoque l\'accès sur https://myaccount.google.com/permissions puis relance le script.',
      );
      process.exit(1);
    }
    console.log('\n✔ Refresh token obtenu. À coller dans le .env :\n');
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    process.exit(0);
  } catch (err) {
    res.writeHead(500).end('Échec de l\'échange du code — voir le terminal.');
    console.error(err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(
    'Ouvre cette URL dans un navigateur CONNECTÉ AU COMPTE GOOGLE DU GROUPE :\n',
  );
  console.log(authUrl);
  console.log(`\n(serveur local en écoute sur ${REDIRECT_URI})`);
});
