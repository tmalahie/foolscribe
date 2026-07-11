/**
 * PoC: turn a raw band-rehearsal recording into a chronological timeline.
 *
 * Two-stage pipeline, because a single audio LLM (e.g. Gemini) is unreliable at
 * absolute timecodes and at separating music from talk:
 *
 *   Stage 1 — perception: ElevenLabs Scribe v2 transcribes with word-level
 *   timestamps, speaker diarization and audio-event tagging. This yields REAL
 *   timecodes, speaker clusters and (music) markers — the things the LLM can't
 *   invent from raw audio.
 *
 *   Stage 2 — reasoning: Claude reads the timestamped/diarized transcript as
 *   TEXT and builds the timeline. It never invents a timecode; it only reasons
 *   over times Scribe already measured — maps speaker ids to first names, and
 *   collapses musical passages into [MUSIQUE] + timecode.
 *
 * Run:
 *   npx ts-node --transpile-only -r dotenv/config scripts/rehearsal-timeline-poc.ts
 * Requires ELEVENLABS_API_KEY and ANTHROPIC_API_KEY (both already in .env).
 */
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';
import * as fs from 'fs';
import { basename } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---- Hardcoded PoC inputs -------------------------------------------------
const AUDIO_PATH = '/Users/tmalahieude/Downloads/Répère Septembre.m4a';
// Upper bound, not an exact count — Scribe predicts fewer when fewer people are
// present. Caps over-splitting from crosstalk/instruments.
const MAX_SPEAKERS = 5;
const REASONING_MODEL = 'claude-opus-4-8';

// A [MUSIQUE] passage = the band actually playing, which Scribe leaves as a
// silence (no transcribed speech) for a sustained stretch. Brief singing or
// humming to illustrate a point mid-discussion is only a few seconds and stays
// in the conversation. This threshold separates the two.
const MUSIC_MIN_GAP_SEC = 30;

// Two music passages separated only by a tiny speech island (a mutter or a
// syllable Scribe caught over the playing) are really one passage. Bridge them
// when the island is this few words or fewer; a longer island is a real comment
// and stays a genuine split.
const MUSIC_BRIDGE_MAX_WORDS = 6;

// Start a new discussion segment when the same speaker resumes after a pause
// this long — otherwise talk on either side of a music passage collapses into
// one mis-timed block.
const SEGMENT_BREAK_SEC = 8;

// Large multipart uploads to Scribe fail intermittently, so files above this are
// re-encoded to a mono MP3 first. The bitrate is derived from duration to land
// near TARGET_UPLOAD_MB whatever the length — a 1h recording lands ~32 kbps,
// still perfectly intelligible for speech. This keeps the whole recording in a
// single request, which preserves consistent diarization and music-gap
// detection (both of which chunking would break).
const COMPRESS_ABOVE_BYTES = 20 * 1024 * 1024;
const TARGET_UPLOAD_MB = 14;
const MIN_BITRATE_KBPS = 24;
const MAX_BITRATE_KBPS = 96;

const MUSICIANS =
  'un guitariste (Chris), un bassiste (Flavien), un batteur (Tristan), un claviériste (Tim) et une chanteuse (Jade)';

const TIMELINE_INSTRUCTIONS = `Le but est de générer un résumé de la répétition sous la forme d'une timeline chronologique concise (style prise de notes propre). Va droit au but, évite la prose inutile et les longues phrases denses.

Il y a deux types de phases distinctes :
1. Les moments où le groupe joue le morceau. Ils sont DÉJÀ détectés et fournis sous forme de lignes "[MUSIQUE] M:SS–M:SS". Reprends-les telles quelles (garde le timecode de début), ne les déduis pas toi-même et n'en ajoute aucune.
2. Les moments de discussion. Fais un résumé rapide et direct des décisions, retours ou problèmes.

Consigne pour les noms :
Chaque segment est étiqueté avec un identifiant de locuteur (speaker_0, speaker_1, ...). Déduis quel identifiant correspond à quel musicien grâce aux prénoms cités dans les échanges et au contexte, puis utilise les vrais prénoms. Si un locuteur reste ambigu, utilise une tournure impersonnelle correcte.

Important : quand quelqu'un chantonne ou fredonne une mélodie pour illustrer un propos pendant une discussion, ce n'est PAS un passage [MUSIQUE] ; ça fait partie de la discussion. Seules les lignes [MUSIQUE] fournies comptent comme du jeu.

Exemple de format attendu (respecte strictement la mise en forme) :
0:00 - Récapitulatif de la structure : intro (4 mesures), 1er couplet (8 mesures), refrain (8 mesures), bridge (8 mesures).
0:48 - Flavien propose d'ajouter un solo de guitare après le 2e refrain.
1:12 - Décision de rejouer le morceau depuis le début.
1:23 - [MUSIQUE]
2:47 - Le refrain manque d'énergie. Tristan propose d'augmenter l'intensité progressivement.
3:35 - [MUSIQUE]
4:26 - C'est mieux mais on n'entend pas assez la basse.`;
// ---------------------------------------------------------------------------

interface Word {
  text: string;
  start?: number;
  end?: number;
  type: 'word' | 'spacing' | 'audio_event';
  // The SDK deserializes the wire field `speaker_id` to camelCase `speakerId`.
  speakerId?: string;
}

function formatTimecode(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Scribe calls cost money and take a while; cache the raw word stream so Stage 1
// post-processing (music-gap threshold) and Stage 2 can be iterated for free.
const cachePath = `${process.cwd()}/tmp/${basename(AUDIO_PATH)}.words.json`;

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

async function prepareUploadFile(): Promise<string> {
  if (fs.statSync(AUDIO_PATH).size <= COMPRESS_ABOVE_BYTES) {
    return AUDIO_PATH;
  }

  const durationSec = await getDurationSec(AUDIO_PATH);
  const targetKbps = Math.floor(
    (TARGET_UPLOAD_MB * 1024 * 1024 * 8) / 1024 / durationSec,
  );
  const bitrateKbps = Math.max(
    MIN_BITRATE_KBPS,
    Math.min(MAX_BITRATE_KBPS, targetKbps),
  );

  const outputPath = `${process.cwd()}/tmp/${basename(AUDIO_PATH)}.upload.mp3`;
  fs.mkdirSync(`${process.cwd()}/tmp`, { recursive: true });
  console.log(`Compressing audio for upload → mono ${bitrateKbps}kbps mp3 ...`);
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    AUDIO_PATH,
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    `${bitrateKbps}k`,
    outputPath,
  ]);
  const mb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`Compressed to ${mb} MB`);
  return outputPath;
}

async function transcribe(): Promise<Word[]> {
  if (fs.existsSync(cachePath)) {
    console.log(`Stage 1 — using cached transcription (${cachePath})`);
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Word[];
  }

  const client = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
  });

  const uploadPath = await prepareUploadFile();
  const buffer = fs.readFileSync(uploadPath);
  const file = new Blob([buffer]);

  console.log('Stage 1 — Scribe v2 (timestamps + diarize + audio events)...');
  const transcription = (await client.speechToText.convert({
    modelId: 'scribe_v2',
    file,
    diarize: true,
    numSpeakers: MAX_SPEAKERS,
    tagAudioEvents: true,
    ...({ timestampsGranularity: 'word' } as any),
  })) as unknown as { words: Word[] };

  if (!transcription.words?.length) {
    throw new Error('Transcription returned no words');
  }

  fs.mkdirSync(`${process.cwd()}/tmp`, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(transcription.words));
  return transcription.words;
}

interface MusicSpan {
  start: number;
  end: number;
}

// Music passages surface as sustained gaps in transcribed speech (Scribe emits
// no words while the band plays). Anything shorter than MUSIC_MIN_GAP_SEC is
// treated as part of the surrounding discussion, not as playing. Passages split
// only by a tiny speech island are then bridged back into one.
function detectMusicSpans(words: Word[]): MusicSpan[] {
  const spoken = words.filter(
    (w): w is Word & { start: number } =>
      w.type === 'word' && w.start != null,
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
 * Collapse the word stream into a compact, timestamped transcript the LLM can
 * reason over: consecutive same-speaker words become one line, and the
 * pre-detected music passages are injected chronologically as authoritative
 * "[MUSIQUE] start–end" markers. Audio-event tags (singing, humming, ...) are
 * dropped — brief singing to illustrate a point is discussion, not playing, and
 * keeping the tags led the model to mark it as [MUSIQUE].
 */
function buildTranscript(words: Word[], musicSpans: MusicSpan[]): string {
  const lines: Line[] = musicSpans.map((span) => ({
    start: span.start,
    text: `[MUSIQUE] ${formatTimecode(span.start)}–${formatTimecode(span.end)}`,
  }));

  let currentSpeaker: string | undefined;
  let currentStart: number | undefined;
  let prevEnd: number | undefined;
  let buffer = '';

  const flush = () => {
    if (buffer.trim().length > 0 && currentStart != null) {
      lines.push({
        start: currentStart,
        text: `${formatTimecode(currentStart)} [${currentSpeaker ?? 'speaker_?'}] ${buffer.trim()}`,
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

    // Words falling inside a music passage are playing noise (e.g. a mutter that
    // got bridged over), not discussion — drop them.
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

async function generateTimeline(transcript: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Voici la transcription horodatée et diarisée d'un enregistrement brut d'une répétition d'un groupe de rock. Le groupe compte jusqu'à ${MAX_SPEAKERS} musiciens (tous ne sont pas forcément présents ce jour-là) : ${MUSICIANS}.

Chaque ligne de discussion est au format "M:SS [speaker_id] texte". Les passages joués sont fournis sous forme de lignes "[MUSIQUE] M:SS–M:SS". Les timecodes sont mesurés et fiables : réutilise-les tels quels, n'en invente aucun.

${TIMELINE_INSTRUCTIONS}

--- TRANSCRIPTION ---
${transcript}
--- FIN TRANSCRIPTION ---

Génère uniquement la timeline finale.`;

  console.log(`Stage 2 — ${REASONING_MODEL} (reasoning over transcript)...`);
  const response = await anthropic.messages.create({
    model: REASONING_MODEL,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Empty response from Claude');
  }
  return textBlock.text.trim();
}

async function main() {
  if (!fs.existsSync(AUDIO_PATH)) {
    throw new Error(`Audio file not found: ${AUDIO_PATH}`);
  }

  const sizeMb = (fs.statSync(AUDIO_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`Input: ${basename(AUDIO_PATH)} (${sizeMb} MB)\n`);

  const words = await transcribe();
  const musicSpans = detectMusicSpans(words);
  console.log(
    `Detected ${musicSpans.length} music passage(s) (gap ≥ ${MUSIC_MIN_GAP_SEC}s):`,
  );
  for (const span of musicSpans) {
    const durationSec = Math.round(span.end - span.start);
    console.log(
      `  ${formatTimecode(span.start)}–${formatTimecode(span.end)} (${durationSec}s)`,
    );
  }
  console.log();

  const transcript = buildTranscript(words, musicSpans);

  const debugPath = `${process.cwd()}/tmp/${basename(AUDIO_PATH)}.transcript.txt`;
  fs.mkdirSync(`${process.cwd()}/tmp`, { recursive: true });
  fs.writeFileSync(debugPath, transcript);
  console.log(`Transcript saved → ${debugPath}\n`);

  const timeline = await generateTimeline(transcript);

  console.log('\n===== Timeline =====\n');
  console.log(timeline);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
