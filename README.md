# foolscribe

Web app PWA du groupe **Fools Mojo** : gestion des enregistrements de
répétitions (synchronisés avec Google Drive) et génération automatique d'une
**timeline annotée** de chaque enregistrement (qui parle, décisions, passages
joués). Spec complète : [PLAN.md](PLAN.md).

## Architecture

- **`web/`** — React + Tailwind, PWA (Vite). Lecture publique, actions
  d'écriture derrière Google Sign-In (liste blanche de 5 emails).
- **`server/`** — Node.js + Express (TypeScript). API, intégration Drive
  (identité backend unique via refresh token), mirror audio vers OVH Object
  Storage (URLs présignées), pipeline d'analyse en 2 étages
  (ElevenLabs Scribe v2 → Claude), MySQL.
- **`deploy/`** — nginx, pm2, script de déploiement.

## Démarrage (dev)

Prérequis : Node ≥ 20, MySQL, `ffmpeg`/`ffprobe` dans le PATH.

```bash
npm install
cp .env.example .env     # puis renseigner les valeurs
npm run dev              # serveur API :3001 + Vite :5173
```

La base et les tables sont créées automatiquement au démarrage du serveur
(la base elle-même doit exister : `CREATE DATABASE foolscribe`).

### Générer le refresh token Google (une fois)

Toutes les opérations Drive passent par **une seule identité backend** : le
compte Google du groupe. Pour générer son refresh token :

```bash
npm run get-refresh-token
```

Ouvrir l'URL affichée **avec le compte Google du groupe**, autoriser, puis
coller la ligne `GOOGLE_OAUTH_REFRESH_TOKEN=…` affichée dans le `.env`.

> Si le client OAuth est de type « Application Web », ajouter d'abord
> `http://localhost:53682/oauth2callback` aux URI de redirection autorisés dans
> la Google Cloud Console. (Type « Ordinateur de bureau » : rien à faire.)

Pour le bouton Google Sign-In du front, ajouter aussi l'origine de l'app
(`http://localhost:5173` en dev, `https://votre-domaine` en prod) aux
**origines JavaScript autorisées** du client OAuth.

## Déploiement (OVH)

1. Cloner le repo sur le serveur, `cp .env.example .env` et tout renseigner.
2. nginx : adapter [deploy/nginx.conf.example](deploy/nginx.conf.example)
   (domaine, chemin du build), puis `certbot --nginx` pour le HTTPS
   (obligatoire : PWA + OAuth).
3. `npm ci && npm run build`
4. `pm2 start deploy/ecosystem.config.cjs && pm2 save`
5. Mises à jour suivantes : `./deploy/deploy.sh`

## Points d'attention (voir PLAN.md pour le détail)

- **Pipeline en 2 étages** (Scribe v2 puis LLM texte) — ne pas revenir à un
  LLM audio unique, il hallucine les timecodes.
- **Pas de découpage du fichier audio** : compression mp3 mono adaptative
  au-dessus de 20 Mo, en une seule requête Scribe.
- **Cache Scribe** : le JSON word-level brut est stocké en base
  (`transcriptions`) — relancer une analyse ne repaye jamais le STT.
- Le SDK ElevenLabs expose `speaker_id` en camelCase **`speakerId`**.
- L'audio est servi par **URLs présignées** de l'Object Storage (Range natif) ;
  Drive reste la source de vérité des fichiers (resync possible).
