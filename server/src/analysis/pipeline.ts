/**
 * Pipeline audio → timeline, portée du PoC `reference/rehearsal-timeline-poc.ts`.
 *
 * Deux étages, parce qu'un LLM audio unique (type Gemini) est incapable de
 * produire des timecodes fiables et de séparer musique/parole en une passe :
 *
 *   Étage 1 — perception : ElevenLabs Scribe v2 transcrit avec timestamps au
 *   mot, diarisation et tags d'événements audio. Timecodes RÉELS, mesurés.
 *
 *   Étage 2 — raisonnement : Claude lit la transcription horodatée/diarisée en
 *   TEXTE et construit la timeline. Il n'invente aucun timecode ; il ne fait
 *   que raisonner sur des temps déjà mesurés par Scribe.
 *
 * Seule évolution vs le PoC : la sortie est du JSON structuré (§4.3 du plan),
 * obtenue via la sortie outillée du LLM (tool_choice forcé), pas du parsing de
 * texte libre.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { config } from '../config';
import { pool } from '../db';
import {
  downloadToTmp,
  getRecordingOrThrow,
  TMP_DIR,
} from '../recordingService';
import type {
  Timeline,
  TimelineEntry,
  TranscriptionRow,
} from '../types';

const execFileAsync = promisify(execFile);

// Borne haute, pas un compte exact — Scribe en prédit moins si moins de
// personnes sont présentes. Limite le sur-découpage dû au crosstalk.
const MAX_SPEAKERS = 5;
export const REASONING_MODEL = process.env.REASONING_MODEL ?? 'claude-opus-4-8';
const STT_MODEL = 'scribe_v2';

// Un passage [MUSIQUE] = le groupe joue réellement, ce que Scribe laisse comme
// un silence de parole soutenu. Un chantonnement bref pour illustrer un propos
// reste dans la discussion. Ce seuil sépare les deux.
const MUSIC_MIN_GAP_SEC = 30;

// Deux passages musicaux séparés seulement par un mini-îlot de parole (un
// marmonnement attrapé par-dessus le jeu) ne font qu'un. On les fusionne quand
// l'îlot fait au plus ce nombre de mots ; plus long = vraie remarque = vraie
// coupure.
const MUSIC_BRIDGE_MAX_WORDS = 6;

// Nouveau segment de discussion quand le même locuteur reprend après une pause
// plus longue que ceci — sinon les prises de parole avant/après un passage joué
// fusionnent en un bloc mal horodaté.
const SEGMENT_BREAK_SEC = 8;

// Les gros uploads multipart vers Scribe échouent par intermittence : au-dessus
// de ce seuil on ré-encode en mp3 mono, bitrate adaptatif visant
// TARGET_UPLOAD_MB. PAS de découpage en segments : le chunking casserait la
// continuité des speaker_N (attribués par requête) et les trous de musique à
// cheval sur une frontière.
const COMPRESS_ABOVE_BYTES = 20 * 1024 * 1024;
const TARGET_UPLOAD_MB = 14;
const MIN_BITRATE_KBPS = 24;
const MAX_BITRATE_KBPS = 96;

const MUSICIANS =
  'un guitariste (Chris), un bassiste (Flavien), un batteur (Tristan), un claviériste (Tim) et une chanteuse (Jade)';

interface Word {
  text: string;
  start?: number;
  end?: number;
  type: 'word' | 'spacing' | 'audio_event';
  // Le SDK ElevenLabs désérialise le champ wire `speaker_id` en camelCase.
  speakerId?: string;
}

export function formatTimecode(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function getDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const duration = parseFloat(stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 1;
}

async function prepareUploadFile(audioPath: string): Promise<string> {
  if (fs.statSync(audioPath).size <= COMPRESS_ABOVE_BYTES) {
    return audioPath;
  }

  const durationSec = await getDurationSec(audioPath);
  const targetKbps = Math.floor(
    (TARGET_UPLOAD_MB * 1024 * 1024 * 8) / 1024 / durationSec,
  );
  const bitrateKbps = Math.max(
    MIN_BITRATE_KBPS,
    Math.min(MAX_BITRATE_KBPS, targetKbps),
  );

  const outputPath = `${audioPath}.upload.mp3`;
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    audioPath,
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    `${bitrateKbps}k`,
    outputPath,
  ]);
  return outputPath;
}

/**
 * Étage 1 (Scribe), avec cache : le JSON word-level brut est stocké dans la
 * table `transcriptions` pour ne jamais repayer le STT (§4.5 du plan) — la
 * timeline peut être régénérée (seuils, prompt, modèle) à partir du cache.
 */
async function transcribe(recordingId: number): Promise<Word[]> {
  const [cached] = await pool.query<TranscriptionRow[]>(
    'SELECT * FROM transcriptions WHERE recording_id = ?',
    [recordingId],
  );
  if (cached[0]) {
    console.log(`[analyse #${recordingId}] Étage 1 — transcription en cache`);
    return JSON.parse(cached[0].words_json) as Word[];
  }

  const recording = await getRecordingOrThrow(recordingId);
  const audioPath = await downloadToTmp(recording);
  const tmpFiles = [audioPath];
  try {
    const uploadPath = await prepareUploadFile(audioPath);
    if (uploadPath !== audioPath) tmpFiles.push(uploadPath);

    const client = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });
    const buffer = fs.readFileSync(uploadPath);
    const file = new Blob([buffer]);

    console.log(
      `[analyse #${recordingId}] Étage 1 — Scribe v2 (timestamps + diarisation + événements audio)…`,
    );
    const transcription = (await client.speechToText.convert({
      modelId: STT_MODEL,
      file,
      diarize: true,
      numSpeakers: MAX_SPEAKERS,
      tagAudioEvents: true,
      ...({ timestampsGranularity: 'word' } as object),
    })) as unknown as { words: Word[]; languageCode?: string };

    if (!transcription.words?.length) {
      throw new Error('La transcription n\'a renvoyé aucun mot');
    }

    await pool.query(
      'INSERT INTO transcriptions (recording_id, words_json, language) VALUES (?, ?, ?)',
      [
        recordingId,
        JSON.stringify(transcription.words),
        transcription.languageCode ?? null,
      ],
    );
    return transcription.words;
  } finally {
    for (const f of tmpFiles) {
      fs.rmSync(f, { force: true });
    }
  }
}

interface MusicSpan {
  start: number;
  end: number;
}

// Les passages joués apparaissent comme des trous soutenus dans la parole
// transcrite (Scribe n'émet aucun mot pendant que le groupe joue). On ne se fie
// PAS aux tags audio « (chant) » : ils se déclenchent aussi sur un fredonnement
// en pleine discussion (faux positifs constatés dans le PoC).
function detectMusicSpans(words: Word[]): MusicSpan[] {
  const spoken = words.filter(
    (w): w is Word & { start: number } => w.type === 'word' && w.start != null,
  );

  const raw: MusicSpan[] = [];
  for (let i = 1; i < spoken.length; i++) {
    const prevEnd = spoken[i - 1].end ?? spoken[i - 1].start;
    const nextStart = spoken[i].start;
    if (nextStart - prevEnd >= MUSIC_MIN_GAP_SEC) {
      raw.push({ start: prevEnd, end: nextStart });
    }
  }

  const merged: MusicSpan[] = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const islandWords = spoken.filter(
        (w) => w.start > prev.end && w.start < span.start,
      ).length;
      if (islandWords <= MUSIC_BRIDGE_MAX_WORDS) {
        prev.end = span.end;
        continue;
      }
    }
    merged.push({ ...span });
  }
  return merged;
}

function isInMusicSpan(seconds: number, spans: MusicSpan[]): boolean {
  return spans.some((span) => seconds >= span.start && seconds < span.end);
}

interface Line {
  start: number;
  text: string;
}

/**
 * Compacte le flux de mots en une transcription horodatée lisible par le LLM :
 * les mots consécutifs d'un même locuteur deviennent une ligne, et les passages
 * musicaux pré-détectés sont injectés chronologiquement comme marqueurs
 * autoritaires. Les tags d'événements audio sont ignorés (un fredonnement en
 * discussion n'est pas de la musique). Chaque ligne porte son timecode en
 * secondes (t=Ns) pour que le LLM le recopie sans conversion.
 */
function buildTranscript(words: Word[], musicSpans: MusicSpan[]): string {
  const lines: Line[] = musicSpans.map((span) => ({
    start: span.start,
    text: `[MUSIQUE] ${formatTimecode(span.start)}–${formatTimecode(span.end)} (t=${Math.floor(span.start)}s–${Math.floor(span.end)}s)`,
  }));

  let currentSpeaker: string | undefined;
  let currentStart: number | undefined;
  let prevEnd: number | undefined;
  let buffer = '';

  const flush = () => {
    if (buffer.trim().length > 0 && currentStart != null) {
      lines.push({
        start: currentStart,
        text: `${formatTimecode(currentStart)} (t=${Math.floor(currentStart)}s) [${currentSpeaker ?? 'speaker_?'}] ${buffer.trim()}`,
      });
    }
    buffer = '';
  };

  for (const word of words) {
    if (word.type === 'audio_event') {
      continue;
    }

    if (word.type === 'spacing') {
      if (buffer.length > 0) {
        buffer += word.text;
      }
      continue;
    }

    // Un mot tombant dans un passage musical est du bruit de jeu (un
    // marmonnement ponté), pas de la discussion — on l'ignore.
    if (word.start != null && isInMusicSpan(word.start, musicSpans)) {
      continue;
    }

    const longPause =
      prevEnd != null && word.start != null
        ? word.start - prevEnd > SEGMENT_BREAK_SEC
        : false;

    if (word.speakerId !== currentSpeaker || longPause) {
      flush();
      currentSpeaker = word.speakerId;
      currentStart = word.start;
    }
    if (currentStart == null) {
      currentStart = word.start;
    }
    buffer += word.text;
    prevEnd = word.end ?? word.start ?? prevEnd;
  }
  flush();

  return lines
    .sort((a, b) => a.start - b.start)
    .map((line) => line.text)
    .join('\n');
}

interface DiscussionEntry {
  timecodeSec: number;
  speaker?: string;
  text: string;
}

const TIMELINE_TOOL: Anthropic.Tool = {
  name: 'submit_timeline',
  description:
    'Soumet la timeline finale de la répétition (entrées de discussion uniquement, ordre chronologique).',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            timecodeSec: {
              type: 'integer',
              description:
                'Timecode de début en secondes, recopié depuis la valeur t=Ns de la transcription (jamais inventé)',
            },
            speaker: {
              type: 'string',
              description:
                "Prénom du locuteur principal de l'entrée ; omettre si ambigu",
            },
            text: {
              type: 'string',
              description:
                'Résumé court et direct (décision, retour, problème)',
            },
          },
          required: ['timecodeSec', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  },
};

/**
 * Étage 2 : le LLM ne produit QUE les entrées de discussion (les passages
 * [MUSIQUE] sont réinjectés de façon déterministe depuis les spans mesurés —
 * jamais déduits par le modèle).
 */
async function generateDiscussionEntries(
  transcript: string,
): Promise<DiscussionEntry[]> {
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const prompt = `Voici la transcription horodatée et diarisée d'un enregistrement brut d'une répétition d'un groupe de rock. Le groupe compte jusqu'à ${MAX_SPEAKERS} musiciens (tous ne sont pas forcément présents ce jour-là) : ${MUSICIANS}.

Chaque ligne de discussion est au format "M:SS (t=Ns) [speaker_id] texte", où t=Ns est le timecode de début en secondes. Les passages joués sont indiqués à titre de contexte par des lignes "[MUSIQUE] M:SS–M:SS (t=Ns–Ns)". Les timecodes sont mesurés et fiables : réutilise-les tels quels via leur valeur t=, n'en invente aucun.

Le but est de générer un résumé de la répétition sous la forme d'une timeline chronologique concise (style prise de notes propre), soumise via l'outil submit_timeline. Va droit au but, évite la prose inutile et les longues phrases denses.

Consignes :
- Ne produis QUE des entrées de discussion : résumé rapide et direct des décisions, retours ou problèmes (ex. « Flavien propose d'ajouter un solo de guitare après le 2e refrain », « Le refrain manque d'énergie : montée progressive en intensité », « Décision de rejouer le morceau depuis le début »). Les passages [MUSIQUE] seront réinjectés automatiquement : ne crée AUCUNE entrée pour eux.
- Regroupe par idée : une entrée par décision/retour/sujet, pas une par phrase. timecodeSec = la valeur t= de la première ligne du passage résumé.
- Noms : déduis quel speaker_N correspond à quel musicien grâce aux prénoms cités dans les échanges et au contexte, puis utilise les vrais prénoms dans les textes et le champ speaker. Si un locuteur reste ambigu, utilise une tournure impersonnelle et omets le champ speaker.
- Quand quelqu'un chantonne ou fredonne une mélodie pour illustrer un propos pendant une discussion, ce n'est PAS un passage musical ; ça fait partie de la discussion.

--- TRANSCRIPTION ---
${transcript}
--- FIN TRANSCRIPTION ---

Soumets la timeline finale via l'outil.`;

  const response = await anthropic.messages.create({
    model: REASONING_MODEL,
    max_tokens: 16384,
    tools: [TIMELINE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_timeline' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolBlock) {
    throw new Error('Réponse du LLM sans appel d\'outil submit_timeline');
  }
  const { entries } = toolBlock.input as { entries: DiscussionEntry[] };
  if (!Array.isArray(entries)) {
    throw new Error('Sortie structurée invalide : entries manquant');
  }
  return entries;
}

/** Exécute la pipeline complète pour un enregistrement et renvoie la timeline. */
export async function runPipeline(recordingId: number): Promise<Timeline> {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const words = await transcribe(recordingId);
  const musicSpans = detectMusicSpans(words);
  console.log(
    `[analyse #${recordingId}] ${musicSpans.length} passage(s) joué(s) détecté(s) (trou ≥ ${MUSIC_MIN_GAP_SEC}s)`,
  );

  const transcript = buildTranscript(words, musicSpans);

  // Trace de debug utile pour re-tuner les seuils (non servie, non critique).
  try {
    fs.writeFileSync(
      path.join(TMP_DIR, `rec-${recordingId}.transcript.txt`),
      transcript,
    );
  } catch {
    // best-effort
  }

  console.log(
    `[analyse #${recordingId}] Étage 2 — ${REASONING_MODEL} (raisonnement sur la transcription)…`,
  );
  const discussionEntries = await generateDiscussionEntries(transcript);

  const entries: TimelineEntry[] = [
    ...discussionEntries.map((e) => ({
      timecodeSec: Math.max(0, Math.floor(e.timecodeSec)),
      type: 'discussion' as const,
      ...(e.speaker ? { speaker: e.speaker } : {}),
      text: e.text,
    })),
    ...musicSpans.map((span) => ({
      timecodeSec: Math.floor(span.start),
      type: 'music' as const,
      endSec: Math.floor(span.end),
    })),
  ].sort((a, b) => a.timecodeSec - b.timecodeSec);

  return {
    generatedAt: new Date().toISOString(),
    model: { stt: STT_MODEL, reasoning: REASONING_MODEL },
    entries,
  };
}
