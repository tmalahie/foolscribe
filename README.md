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

Le build (`npm ci` + `vite build` + `tsc`) tourne sur un **runner GitHub**, pas
sur le VPS : celui-ci ne fait plus que recevoir le résultat et redémarrer pm2.
**Tout push sur `main` déclenche le déploiement**
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)), relançable à la
main depuis l'onglet Actions (« Run workflow »).

### Installation initiale du serveur (une fois)

1. Cloner le repo sur le serveur, `cp .env.example .env` et tout renseigner.
   Le `.env` reste sur le serveur : il n'est ni commité ni envoyé par la CI.
2. Reverse proxy vers le port 3001 (`PORT` du .env) : adapter
   [deploy/apache-vhost.conf.example](deploy/apache-vhost.conf.example) ou
   [deploy/nginx.conf.example](deploy/nginx.conf.example), puis
   `certbot --apache` / `certbot --nginx` pour un vrai certificat HTTPS
   (obligatoire : PWA + OAuth refusent un certificat invalide).
3. `npm ci && npm run build` puis
   `pm2 start deploy/ecosystem.config.cjs && pm2 save`.
   (Les déploiements suivants n'auront plus besoin de compiler ici.)
4. Ajouter `https://<domaine>` aux origines JavaScript autorisées du client
   OAuth Google (console Google Cloud).

### Brancher la CI (une fois)

Le déploiement se connecte en **`timothe`** (pas en root). Sur le VPS, cet
utilisateur possède `/var/www/malahieude.net/foolscribe` et dispose d'une règle
sudo limitée au seul pilotage de l'app :

```bash
# wrapper pm2 (pm2 tourne sous root, binaires dans /root/.nvm en 0700)
scp deploy/foolscribe-pm2 ovh:/tmp/
ssh ovh 'install -o root -g root -m 755 /tmp/foolscribe-pm2 /usr/local/sbin/'
# règle sudo dédiée — /etc/sudoers.d/foolscribe-deploy, 0440 :
#   timothe ALL=(root) NOPASSWD: /usr/local/sbin/foolscribe-pm2
```

Le wrapper n'accepte que `restart`, `logs` et `status`, et ses chemins sont en
dur : `timothe` ne gagne aucun autre pouvoir root. Vérifier avec
`sudo -l -U timothe`.

Puis créer les secrets du repo (Settings → Secrets and variables → Actions) :

| Secret | Valeur |
| --- | --- |
| `DEPLOY_HOST` | hôte du VPS |
| `DEPLOY_USER` | `timothe` |
| `DEPLOY_PATH` | `/var/www/malahieude.net/foolscribe` |
| `DEPLOY_SSH_KEY` | clé **privée** dont la publique est dans `/home/timothe/.ssh/authorized_keys` |
| `DEPLOY_KNOWN_HOSTS` | sortie de `ssh-keyscan <hôte>` (évite un `StrictHostKeyChecking=no`) |
| `DEPLOY_PORT` | *(optionnel)* port SSH si ≠ 22 |

> L'app elle-même tourne encore **en root** sous le pm2 de root (aux côtés de
> `btfusion`). Seul le déploiement est dé-rooté. La basculer sous `timothe`
> (pm2 + `pm2 startup` dédiés) supprimerait le besoin de sudo — pas fait pour
> l'instant : ça implique une coupure et un second node sur un disque déjà à 92 %.

### Ce que fait le job

1. Runner : `npm ci`, `npm run build` (le build typecheck aussi), puis
   réinstallation d'un `node_modules` **production seule** (racine + workspace
   `server` ; aucune dépendance native, l'arbre est portable tel quel).
2. `rsync` de `server/dist`, `web/dist`, `node_modules`, `deploy/` et des
   `package.json` vers `<DEPLOY_PATH>/.deploy/` — un miroir persistant, donc
   seuls les fichiers modifiés transitent d'un déploiement à l'autre.
3. [deploy/release.sh](deploy/release.sh) sur le VPS : bascule ces répertoires
   en place (copie en hard links, l'ancienne version gardée en `.old`),
   `pm2 startOrRestart`, puis health check sur `/api/config`. En cas d'échec du
   redémarrage ou du health check, **rollback automatique** vers la version
   précédente et job en rouge.

Le clone git du serveur n'est plus mis à jour (`git pull` n'a plus lieu) : ses
sources sont figées, seul le build compte. [deploy/deploy.sh](deploy/deploy.sh)
reste utilisable en dépannage si la CI est indisponible, mais il compile sur le
VPS — c'est précisément ce qu'on cherche à éviter.

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
