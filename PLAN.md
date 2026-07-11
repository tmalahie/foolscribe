# Foolscribe — Plan de développement (handoff)

> Web app PWA pour le groupe de musique **Fools Mojo** : gérer les enregistrements
> de répétitions (synchronisés avec Google Drive) et générer automatiquement une
> **timeline annotée** de chaque enregistrement (qui parle, décisions, passages
> joués) via une pipeline audio→texte déjà prototypée.
>
> Ce document est autoportant : il contient tout le contexte, l'architecture
> cible, le modèle de données, les intégrations, les pièges connus et un
> découpage en phases. Le PoC de la pipeline d'analyse est fourni et fonctionnel
> dans `reference/rehearsal-timeline-poc.ts` — c'est le cœur du produit, à
> porter tel quel côté backend.

---

## 1. Objectif & utilisateurs

- **Pour qui** : les 5 membres du groupe (usage privé, ~5 personnes).
- **Quoi** : centraliser les enregistrements de répètes et, pour chacun, produire
  une **timeline chronologique** en notes propres :
  - les moments de discussion → résumé court et direct (décisions, retours) ;
  - les moments où le groupe joue → une ligne `[MUSIQUE]` + timecode (jamais les
    paroles).
- **UX clé** : sur la page d'un enregistrement, un lecteur audio + la timeline ;
  cliquer un timecode de la timeline **seek le lecteur** à cet instant.

## 2. Choix produit déjà arrêtés

| Sujet | Décision |
|---|---|
| Source de vérité des fichiers | **Google Drive** (compte perso). 1 dossier racine → 1 sous-dossier par répète → 1 fichier audio par enregistrement. |
| Base de données | **MySQL** (déjà présente sur le serveur OVH) — sert d'index/cache de Drive + stockage des analyses. |
| Stockage & service de l'audio | **OVH Object Storage** (S3-compatible) — mirror de Drive, servi via URLs présignées (Range natif). Pas de cache disque local (espace serveur limité), pas d'éviction. |
| Accès Drive côté backend | **Une seule identité** : un refresh token OAuth d'un compte Google dédié au groupe. Pas de service account (piège quota sur Drive perso, voir §7). |
| Lecture | **Publique par défaut** (pas de login pour consulter/écouter). |
| Écriture (créer répète, uploader, lancer analyse) | Requiert d'être **connecté avec un compte Google** dont l'email est dans une **liste blanche hardcodée** (5 emails). |
| Fichiers ajoutés directement dans Drive | **Oui, ça arrive** → prévoir une **resynchro Drive→MySQL**. |
| Offline | **Lecture seule** (v1) : écouter les enregistrements téléchargés + voir les analyses déjà faites. Pas d'écriture hors-ligne. |
| Nom | **foolscribe** (clin d'œil à Fools Mojo). |

## 3. Stack cible

- **Front** : React + Tailwind, en **PWA** (service worker + manifest). Pas de
  librairie de composants imposée ; rester simple et propre. Éviter les usines à
  gaz.
- **Back** : Node.js + Express (TypeScript recommandé, cohérent avec le PoC).
- **DB** : MySQL.
- **Hébergement** : serveur perso OVH. **HTTPS obligatoire** (PWA + service
  worker + OAuth Google l'exigent) → nginx + certbot (Let's Encrypt).
- **Process** : pm2 ou systemd pour garder le serveur Node up.

---

## 4. Ce qui existe déjà : la pipeline d'analyse (le cœur)

Fichier : `reference/rehearsal-timeline-poc.ts` (script Node/TS autoportant,
testé sur 2 vraies répètes). **À porter dans le backend**, avec une seule
évolution : produire du **JSON structuré** au lieu de texte (voir §4.3).

### 4.1 Architecture en 2 étages (et pourquoi)

Un seul LLM audio (type Gemini) a été essayé en premier et **rejeté** : il est
incapable de produire des timecodes fiables (il les hallucine, ils dérivent sur
un enregistrement long) et de séparer musique/parole en une passe. Ne pas y
revenir. La pipeline retenue sépare **perception** et **raisonnement** :

- **Étape 1 — Perception : ElevenLabs Scribe v2** (speech-to-text).
  Paramètres : `modelId: 'scribe_v2'`, `diarize: true`,
  `numSpeakers: <taille du groupe>`, `tagAudioEvents: true`,
  `timestampsGranularity: 'word'`. Renvoie des **timecodes réels au mot**, des
  **locuteurs** (`speaker_0…N`) et des **événements audio** (musique, rires…).
- **Étape 2 — Raisonnement : un LLM texte** (le PoC utilise Claude
  `claude-opus-4-8`). On lui donne la transcription horodatée + diarisée **en
  texte** ; il ne fait que raisonner sur des timecodes déjà mesurés (il n'en
  invente aucun) : il mappe les `speaker_N` vers les prénoms des musiciens et
  résume les discussions.

### 4.2 Détection des passages `[MUSIQUE]` (déterministe, pas via le LLM)

Découverte importante du PoC : quand le groupe joue, **Scribe ne transcrit
rien** pendant plusieurs dizaines de secondes → un **silence de parole** = de la
musique. On ne se fie PAS aux tags audio « (chant) » (ils se déclenchent aussi
quand quelqu'un fredonne pour illustrer un propos → faux positifs).

Logique (paramètres tunés dans le PoC) :
- `MUSIC_MIN_GAP_SEC = 30` : un trou ≥ 30 s entre deux mots = passage joué.
- `MUSIC_BRIDGE_MAX_WORDS = 6` : deux passages séparés seulement par un mini-îlot
  de parole (≤ 6 mots, ex. un « ça aussi, ça » marmonné pendant le jeu) sont
  **fusionnés** en un seul passage. Un îlot plus long (vraie remarque) reste une
  vraie coupure.
- `SEGMENT_BREAK_SEC = 8` : on démarre un nouveau segment de discussion quand le
  même locuteur reprend après une pause > 8 s (évite qu'une prise de parole
  avant/après un passage joué fusionne en un bloc mal horodaté).

### 4.3 Évolution à faire au portage : sortie JSON structurée

Le PoC sort du texte formaté. Pour le web (clic-vers-seek + rendu propre), la
pipeline doit renvoyer un objet :

```jsonc
{
  "generatedAt": "2026-07-11T…",
  "model": { "stt": "scribe_v2", "reasoning": "claude-opus-4-8" },
  "entries": [
    { "timecodeSec": 0,   "type": "discussion", "speaker": "Chris", "text": "…" },
    { "timecodeSec": 49,  "type": "music", "endSec": 274 },
    { "timecodeSec": 274, "type": "discussion", "speaker": "Jade",  "text": "…" }
  ]
}
```

Chaque entrée porte un `timecodeSec` numérique → le front rend une ligne
cliquable qui fait `audioEl.currentTime = timecodeSec`. Obtenir ce JSON de façon
fiable : utiliser la sortie structurée du LLM (tool/JSON mode) plutôt que de
parser du texte libre.

### 4.4 Compression pour l'upload (fichiers longs)

Les gros uploads multipart vers Scribe échouent par intermittence (constaté :
11,7 Mo OK, 30 Mo KO). Donc : au-dessus de `COMPRESS_ABOVE_BYTES` (20 Mo), on
ré-encode en **mp3 mono**, à un **bitrate adaptatif** calculé depuis la durée
pour viser ~`TARGET_UPLOAD_MB` (14 Mo), borné `[24, 96]` kbps. Une répète d'1 h
tombe ainsi à ~32 kbps / ~14 Mo, largement suffisant pour de la parole, et **en
une seule requête**.

**Ne pas découper le fichier en segments.** Le découpage casse les deux choses
sur lesquelles la pipeline repose : (1) l'identité des locuteurs (`speaker_N`
est attribué **par requête** — pas de continuité entre chunks), (2) les trous de
musique à cheval sur une frontière. La limite dure de Scribe est 3 Go / requête,
donc la compression seule couvre le multi-heures.

### 4.5 Cache — ne pas repayer Scribe

Stocker le **JSON word-level brut** de Scribe (par enregistrement). Il permet de
re-générer la timeline (re-tuner les seuils, changer le prompt/modèle du LLM)
sans refaire l'appel STT (le plus lent et coûteux). Dans le PoC c'est un fichier
`tmp/…words.json` ; en prod, une colonne/table dédiée (voir §5).

### 4.6 Pièges connus / limites à assumer

- **`speaker_id` → `speakerId`** : le SDK ElevenLabs JS désérialise le champ wire
  `speaker_id` en **camelCase `speakerId`**. Lire le mauvais nom = 0 locuteur
  détecté (bug rencontré et corrigé dans le PoC).
- **Diarisation imparfaite** : elle sur-découpe parfois (5 clusters pour 4
  présents). Le mapping `speaker_N`→prénom est **best-effort** et **varie d'un
  run à l'autre** (un run a cru Jade absente, un autre Tristan). Pour un groupe
  fixe : hardcoder le roster des prénoms aide, mais accepter que les prénoms
  soient parfois approximatifs. Une vraie fiabilité passerait par de
  l'enrollment vocal par membre — **hors scope v1**.
- **Non-déterminisme** près des seuils (bornes de passages à ±quelques
  secondes). Sans impact pour des notes.
- **Chant intelligible** : la détection musique suppose que Scribe ne transcrit
  pas les paroles chantées (vérifié sur les 2 répètes). Si un jour il transcrit
  des paroles claires comme des mots, ce passage n'aurait pas de « trou » et
  serait raté. À surveiller, pas bloquant.

### 4.7 Clés & coûts

La pipeline nécessite **des comptes/API keys propres au projet** (le PoC tournait
sur les clés d'un autre projet) :
- `ELEVENLABS_API_KEY` — compte ElevenLabs avec accès Scribe v2 (facturé à la
  durée transcrite).
- `ANTHROPIC_API_KEY` — compte Anthropic (facturé aux tokens de la timeline).
- `ffmpeg` + `ffprobe` installés sur le serveur.

---

## 5. Modèle de données (MySQL)

Drive = source de vérité des **fichiers** ; MySQL = **index + analyses + cache**.

```
rehearsals
  id              PK
  name            varchar
  date            date            -- date de la répète (optionnel)
  drive_folder_id varchar         -- id du dossier Drive
  created_at      datetime

recordings
  id              PK
  rehearsal_id    FK -> rehearsals.id
  filename        varchar
  drive_file_id   varchar UNIQUE  -- id du fichier Drive (clé de dédup au sync)
  duration_sec    int NULL
  size_bytes      bigint NULL
  object_key      varchar NULL    -- clé de l'objet dans l'Object Storage (audio servi)
  mirrored_at     datetime NULL   -- date de copie Drive -> Object Storage (null = pas encore mirroré)
  created_at      datetime

transcriptions                    -- cache Scribe (évite de repayer le STT)
  id              PK
  recording_id    FK -> recordings.id UNIQUE
  words_json      json/longtext   -- sortie word-level brute de Scribe
  language        varchar
  created_at      datetime

analyses
  id              PK
  recording_id    FK -> recordings.id
  status          enum(pending,running,done,error)
  timeline_json   json/longtext NULL   -- la timeline structurée (§4.3)
  reasoning_model varchar
  error           text NULL
  created_at      datetime
  updated_at      datetime
```

- Pas de table `users` : liste blanche des emails **hardcodée** (5 emails).
- Sessions : JWT signé en cookie httpOnly (stateless, pas de table nécessaire).

---

## 6. API backend (esquisse)

Lecture (publique) :
- `GET  /api/rehearsals` — liste des répètes.
- `GET  /api/rehearsals/:id/recordings` — enregistrements d'une répète.
- `GET  /api/recordings/:id` — détail + dernière analyse.
- `GET  /api/recordings/:id/audio` — **redirige (302) vers une URL présignée**
  de l'Object Storage. Le navigateur lit alors l'audio directement depuis
  l'Object Storage, avec **Range requests** natives (seek), sans consommer la
  bande passante du serveur. Si l'objet n'est pas encore mirroré (`object_key`
  null), le backend le copie d'abord depuis Drive (voir §7).

Écriture (auth requise, email dans la liste blanche) :
- `POST /api/rehearsals` — crée la répète **+ le dossier Drive**.
- `POST /api/rehearsals/:id/recordings` — upload multipart → **envoi Drive** +
  cache local + ligne DB.
- `POST /api/recordings/:id/analyze` — lance un **job d'analyse asynchrone**
  (l'analyse d'1 h prend > 1 min : ne pas bloquer la requête HTTP). Renvoie un id
  de job / met `analyses.status = running`.
- `POST /api/sync` — **resynchro Drive→MySQL** (détecte les dossiers/fichiers
  ajoutés directement dans Drive, dédup par `drive_file_id`).

Auth :
- `POST /api/auth/google` — vérifie l'ID token Google, contrôle l'email vs liste
  blanche, pose un cookie de session.
- `GET  /api/auth/me` / `POST /api/auth/logout`.

Suivi d'analyse : soit polling `GET /api/recordings/:id` (le front rafraîchit
tant que `status = running`), soit un simple SSE. Polling suffit pour un v1.

---

## 7. Intégration Google Drive (compte perso)

- **Une identité backend unique** : générer une fois un **refresh token OAuth**
  du compte Google du groupe (scope `drive` ou `drive.file`), le stocker en
  secret côté serveur. Toutes les lectures/écritures Drive passent par ce token
  (rafraîchi automatiquement). **Le login Google des membres NE sert PAS à
  accéder à Drive** — uniquement à autoriser (vérif email).
- **Pourquoi pas un service account** : sur un Drive **perso** (hors Workspace),
  un service account n'a pas de quota de stockage propre → erreurs
  « Service Accounts do not have storage quota » à l'upload. Le refresh token
  d'un vrai compte évite ça. (Si un jour migration vers Workspace + Shared Drive,
  le service account redevient une option propre.)
- **Structure** : dossier racine configurable (id en env). `POST /rehearsals`
  crée un sous-dossier ; l'upload crée le fichier dans le sous-dossier de la
  répète.
- **Resync** : lister les sous-dossiers du root + leurs fichiers, upsert dans
  MySQL par `drive_file_id`. Déclenchable à la main (bouton) et/ou périodique.
- **Audio** : ne pas streamer live depuis Drive à chaque lecture (quotas,
  latence, pas de Range fiable). L'audio est **mirroré dans l'OVH Object Storage**
  (S3-compatible) et servi via **URLs présignées** — Range natif (seek), zéro
  bande passante serveur, et pas de contrainte d'espace disque (donc **pas
  d'éviction** à gérer au vu du volume du groupe).
  - À l'upload via l'app : écrire dans **Drive** (source de vérité) **et** dans
    l'Object Storage (`object_key` renseigné, `mirrored_at` daté).
  - Pour un fichier **déposé directement dans Drive** (détecté au resync) : le
    copier Drive→Object Storage au resync, ou **paresseusement** à la première
    lecture (`GET …/audio` : si `object_key` null, copier puis rediriger).
  - Accès S3 côté backend : SDK S3 (`@aws-sdk/client-s3` +
    `@aws-sdk/s3-request-presigner`) pointé sur l'endpoint OVH Object Storage.

---

## 8. Auth & autorisation

- Front : **Google Sign-In** (bouton), récupère un ID token.
- Back : vérifie l'ID token (lib Google), extrait l'email, contrôle vs
  `ALLOWED_EMAILS` (env/const, 5 emails), émet un JWT en cookie httpOnly.
- **Gating des écritures** : middleware sur les routes d'écriture.
- **UX** : la lecture ne demande jamais de login. Au moment d'une **action
  d'écriture** (ex. clic « Ajouter un enregistrement » ou « Lancer l'analyse »),
  si non connecté → proposer la connexion Google en place (modale), puis
  rejouer l'action.

> Note : la lecture étant publique, n'importe qui avec l'URL peut écouter les
> enregistrements. Acceptable d'après le brief. Si un jour ces prises ne doivent
> pas fuiter, prévoir une lecture derrière auth aussi (URL obscure en attendant).

---

## 9. Pages & UX (front)

1. **Liste des répétitions** — cartes/liste (nom, date, nb d'enregistrements).
   Bouton « Nouvelle répète » (écriture → login si besoin).
2. **Détail d'une répète** — liste des enregistrements. Bouton « Ajouter un
   enregistrement » (upload). Bouton « Resynchroniser depuis Drive ».
3. **Page enregistrement** :
   - **Lecteur audio** (élément `<audio>`), barre de progression.
   - **Bouton « Lancer l'analyse »** (écriture) → job async → état
     (pending/running/done/error) affiché ; quand `done`, afficher la timeline.
   - **Timeline** : liste d'entrées ; chaque ligne affiche `M:SS` + le texte (ou
     `[MUSIQUE]`). **Clic sur une ligne → seek** le lecteur (`currentTime`).
     Idéalement, surligner la ligne active pendant la lecture (`timeupdate`).
   - **Bouton « Disponible hors-ligne »** (voir §10).

Tailwind pour le style ; viser lisible et propre, pas de sur-ingénierie.

## 10. PWA / offline (lecture seule, v1)

- **Manifest** + **service worker**. App shell (JS/CSS/HTML) précaché →
  l'interface s'ouvre sans réseau.
- **Données** (listes, analyses) : mises en cache au fil des visites
  (stale-while-revalidate) → consultables hors-ligne pour ce qui a déjà été vu.
- **Audio** : **pas de téléchargement par défaut** (gros fichiers). Un bouton
  « Disponible hors-ligne » sur la page d'un enregistrement (façon téléchargement
  Spotify) récupère les octets audio + l'analyse et les **épingle sous une clé
  stable** (id de l'enregistrement) dans IndexedDB / Cache Storage. Comme on
  stocke le blob explicitement, c'est **indépendant de l'expiration des URLs
  présignées** : la lecture hors-ligne lit le blob local. Un indicateur montre ce
  qui est dispo offline et permet de le retirer.
- Hors-ligne, les actions d'écriture sont **désactivées** (avec message clair).
- Cas d'usage cible : au studio (mauvais réseau), écouter les prises épinglées et
  relire leurs analyses.

## 11. Déploiement (OVH)

- **nginx** en reverse proxy + **certbot** (HTTPS, requis PWA/OAuth). Sert le
  build front statique et proxifie `/api` vers Node.
- Process Node géré par **pm2** (ou systemd).
- **Script de déploiement simple**, lancé sur le serveur :
  ```bash
  git pull
  npm ci
  npm run build            # build front + compile back
  pm2 restart foolscribe   # ou systemctl restart
  ```
- **Secrets** en env (`.env` non commité) : `ELEVENLABS_API_KEY`,
  `ANTHROPIC_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`,
  `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `MYSQL_*`, `JWT_SECRET`, `ALLOWED_EMAILS`,
  `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
  (OVH Object Storage).

---

## 12. Découpage en phases suggéré

1. **Socle** : repo (front React+Tailwind PWA / back Express+TS / MySQL),
   schéma DB, config env, nginx+HTTPS, script de déploiement. App qui liste des
   répètes en dur.
2. **Google Drive (lecture)** : refresh token backend, listing root→répètes→
   enregistrements, resync Drive→MySQL, audio proxifié avec Range + cache local,
   lecteur front. *(Tout en lecture publique.)*
3. **Auth + écritures** : Google Sign-In + liste blanche + sessions ; création de
   répète (dossier Drive), upload d'enregistrement (Drive + cache + DB), gating +
   UX de login à la volée.
4. **Analyse** : porter `reference/rehearsal-timeline-poc.ts` en service backend,
   sortie JSON structurée (§4.3), cache Scribe (§4.5), job async + statut ;
   affichage timeline + **clic-vers-seek**.
5. **PWA offline** : service worker, précache app shell, cache données, bouton
   « disponible hors-ligne » pour audio + analyse, désactivation des écritures
   hors-ligne.
6. **Finitions** : surlignage de la ligne active pendant la lecture, états de
   chargement/erreur, resync périodique, petits soins UX.

## 13. Points à confirmer par l'agent en début de projet

- Roster des musiciens (prénoms + rôles) et **liste blanche des 5 emails** →
  à récupérer auprès du propriétaire.
- Id du **dossier racine Drive** et génération du **refresh token OAuth**
  (flow one-shot à scripter).
- Comptes ElevenLabs / Anthropic créés et clés dispo (§4.7).
- **OVH Object Storage** : les identifiants (`S3_*`) sont déjà fournis dans le
  `.env` local (bucket `foolscribe`, région `gra`, endpoint
  `https://s3.gra.io.cloud.ovh.net`). Ne jamais commiter le `.env` — un
  `.env.example` versionné sert de template.
- Modèle de raisonnement (garder `claude-opus-4-8`, ou tester un modèle moins
  cher pour l'étape texte — c'est du pur raisonnement sur transcription).

---

## Annexe — le PoC fourni

`reference/rehearsal-timeline-poc.ts` : script Node/TS autoportant, **testé et
fonctionnel**, qui exécute toute la pipeline (compression adaptative → Scribe v2
→ détection musique → timeline via Claude). Il lit les chemins/roster en dur en
tête de fichier. C'est la référence d'implémentation de l'étape d'analyse ;
le portage backend doit en reprendre la logique et n'ajouter que la sortie JSON
structurée + le stockage (cache Scribe, table `analyses`).

Dépendances utilisées : `@elevenlabs/elevenlabs-js`, `@anthropic-ai/sdk`,
`ffmpeg`/`ffprobe`, `dotenv`.
