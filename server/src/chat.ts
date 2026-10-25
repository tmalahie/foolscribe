/**
 * Chat sur un enregistrement : Claude lit la transcription horodatée (même
 * format que l'étage 2 de la pipeline) et la timeline actuelle, répond aux
 * questions (« quand est-ce qu'on a parlé de X ? ») et peut corriger la
 * timeline, la transcription et le contexte du groupe via des outils.
 *
 * La conversation est partagée par tout le groupe (une par enregistrement).
 * Seuls les textes sont rejoués d'un tour à l'autre : chaque tour reconstruit
 * le prompt avec la transcription et la timeline à jour.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ResultSetHeader } from 'mysql2';
import { latestAnalysis } from './analysis/jobs';
import {
  buildTranscript,
  detectMusicSpans,
  formatTimecode,
  MUSICIANS,
  type Word,
} from './analysis/pipeline';
import { getBandContext, setBandContext } from './bandContext';
import { config } from './config';
import { pool } from './db';
import { HttpError } from './errors';
import { getRecordingOrThrow } from './recordingService';
import { normalizeEntry, saveTimelineEntries } from './timeline';
import type {
  AnalysisRow,
  ChatMessageRow,
  Timeline,
  TimelineEntry,
  TranscriptionRow,
} from './types';

const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-opus-5-5';
// Repli côté serveur si le modèle principal décline la requête.
const FALLBACK_MODEL = 'claude-opus-4-8';
const MAX_TOOL_ROUNDS = 10;
// Messages rejoués comme historique (les plus récents).
const HISTORY_LIMIT = 40;
const MAX_MESSAGE_CHARS = 4000;

export interface ChatAction {
  type: 'timeline' | 'transcript' | 'context';
  summary: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  actions: ChatAction[];
  authorEmail: string | null;
  createdAt: string;
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    actions: row.actions_json ? (JSON.parse(row.actions_json) as ChatAction[]) : [],
    authorEmail: row.author_email,
    createdAt: row.created_at,
  };
}

export async function listChatMessages(recordingId: number): Promise<ChatMessage[]> {
  const [rows] = await pool.query<ChatMessageRow[]>(
    'SELECT * FROM chat_messages WHERE recording_id = ? ORDER BY id',
    [recordingId],
  );
  return rows.map(toChatMessage);
}

async function insertMessage(
  recordingId: number,
  role: 'user' | 'assistant',
  content: string,
  authorEmail: string | null,
  actions: ChatAction[] = [],
): Promise<ChatMessage> {
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO chat_messages (recording_id, role, content, actions_json, author_email) VALUES (?, ?, ?, ?, ?)',
    [
      recordingId,
      role,
      content,
      actions.length ? JSON.stringify(actions) : null,
      authorEmail,
    ],
  );
  const [rows] = await pool.query<ChatMessageRow[]>(
    'SELECT * FROM chat_messages WHERE id = ?',
    [result.insertId],
  );
  return toChatMessage(rows[0]);
}

export async function clearChat(recordingId: number): Promise<void> {
  await pool.query('DELETE FROM chat_messages WHERE recording_id = ?', [recordingId]);
}

// --- Contexte du tour -------------------------------------------------------

async function loadWords(recordingId: number): Promise<Word[]> {
  const [rows] = await pool.query<TranscriptionRow[]>(
    'SELECT words_json FROM transcriptions WHERE recording_id = ?',
    [recordingId],
  );
  if (!rows[0]) {
    throw new HttpError(409, 'Pas encore de transcription : lance d’abord l’analyse');
  }
  return JSON.parse(rows[0].words_json) as Word[];
}

function formatTimeline(timeline: Timeline | null): string {
  if (!timeline) return '(pas de timeline : analyse non terminée)';
  if (!timeline.entries.length) return '(timeline vide)';
  return timeline.entries
    .map((e, i) => {
      if (e.type === 'music') {
        const range =
          e.endSec != null
            ? `${formatTimecode(e.timecodeSec)}–${formatTimecode(e.endSec)} (t=${e.timecodeSec}s–${e.endSec}s)`
            : `${formatTimecode(e.timecodeSec)} (t=${e.timecodeSec}s)`;
        return `[${i}] ${range} ♪ musique : ${e.text ?? '(sans libellé)'}`;
      }
      return `[${i}] ${formatTimecode(e.timecodeSec)} (t=${e.timecodeSec}s) discussion : ${e.text ?? ''}`;
    })
    .join('\n');
}

function systemPrompt(
  filename: string,
  bandContext: string,
  transcript: string,
): string {
  return `Tu es l'assistant de Fools Mojo, un groupe de rock : ${MUSICIANS}. Tu discutes avec les membres du groupe à propos de l'enregistrement d'une répétition (« ${filename} »).

Tu disposes de :
- la transcription horodatée et diarisée ci-dessous (lignes "M:SS (t=Ns) [speaker_id] texte", passages joués "[MUSIQUE #k] M:SS–M:SS"). Elle est automatique : homophones (« l'idée de… » pour « l'idée deux »), mots mal compris, locuteurs parfois mal séparés.
- la timeline actuelle (résumé chronologique affiché dans l'appli), jointe à chaque message, entrées numérotées [i].

Ce que tu fais :
- Répondre aux questions sur la répète (« quand est-ce qu'on a parlé de X ? », « qu'est-ce qu'on a décidé pour le refrain ? »). Donne les moments au format M:SS (ex. 37:15) : l'appli en fait des liens cliquables. Ne cite que des timecodes présents dans la transcription ou la timeline.
- Modifier la timeline (update_timeline) quand on te le demande, y compris les corrections qui en découlent (ex. renommer tous les passages d'un morceau mal identifié).
- Corriger la transcription (edit_transcript) quand on te signale un mot mal transcrit, ou quand une correction évidente sert la demande.
- Mettre à jour le contexte du groupe (update_band_context) quand un membre donne une info durable, valable au-delà de cette répète : nom ou surnom d'un morceau, numérotation des idées, vocabulaire du groupe. Pas pour un fait propre à cette répète. Conserve le reste du contexte et garde-le concis.

Style : français, tutoiement, réponses courtes et directes. Les numéros [i] de la timeline sont internes : ne les cite pas, donne les timecodes. Après une modification, dis en une ligne ce que tu as changé. Si une demande de modification est trop ambiguë pour être faite sans risque d'erreur, pose la question au lieu de modifier.
Prénoms : utilise-les quand la personne est identifiable de façon solide (nommée, interpellée, ou rôle sans ambiguïté). Ne déduis jamais un prénom de la seule étiquette speaker_N.

--- CONTEXTE DU GROUPE (notes tenues par les musiciens) ---
${bandContext || '(vide pour l\'instant)'}
--- FIN CONTEXTE ---

--- TRANSCRIPTION ---
${transcript}
--- FIN TRANSCRIPTION ---`;
}

// --- Outils -----------------------------------------------------------------

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'update_timeline',
    description:
      'Modifie la timeline de l\'enregistrement. Les index [i] sont ceux de la timeline actuelle (la plus récente fournie, y compris dans un résultat d\'outil). Toutes les opérations d\'un appel portent sur la même version et sont appliquées ensemble ; la timeline est ensuite retriée par timecode et renvoyée renumérotée.',
    input_schema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['update', 'delete', 'add'] },
              index: {
                type: 'integer',
                description: 'Entrée visée (update, delete)',
              },
              type: {
                type: 'string',
                enum: ['discussion', 'music'],
                description: 'Type de la nouvelle entrée (add)',
              },
              timecodeSec: {
                type: 'integer',
                description: 'Début en secondes, repris d\'une valeur t= (add, ou update pour le déplacer)',
              },
              endSec: {
                type: 'integer',
                description: 'Fin en secondes d\'un passage musical',
              },
              text: {
                type: 'string',
                description: 'Texte d\'une discussion ou libellé d\'un passage musical (chaîne vide = retirer le libellé d\'un passage)',
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
      },
      required: ['operations'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_transcript',
    description:
      'Corrige des mots mal transcrits. Chaque remplacement cherche une suite de mots consécutifs (comparaison insensible à la casse, aux accents et à la ponctuation) et la remplace ; les timecodes restent ceux d\'origine. Restreins avec fromSec/toSec dès que l\'expression peut apparaître ailleurs avec son sens normal.',
    input_schema: {
      type: 'object',
      properties: {
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Mots à trouver, ex. « l\'idée de »' },
              replace: { type: 'string', description: 'Remplacement, ex. « l\'idée deux »' },
              fromSec: { type: 'integer', description: 'Début de la zone (secondes), optionnel' },
              toSec: { type: 'integer', description: 'Fin de la zone (secondes), optionnel' },
            },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['replacements'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_band_context',
    description:
      'Remplace le contexte du groupe (notes durables partagées par toutes les répètes et injectées dans les analyses futures). Fournis le texte complet : l\'existant conservé + la nouvelle info.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Nouveau contexte complet' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
];

interface TimelineOperation {
  action: 'update' | 'delete' | 'add';
  index?: number;
  type?: 'discussion' | 'music';
  timecodeSec?: number;
  endSec?: number;
  text?: string;
}

function applyTimelineOperations(
  entries: TimelineEntry[],
  operations: TimelineOperation[],
): TimelineEntry[] {
  const next: (TimelineEntry | null)[] = entries.map((e) => ({ ...e }));
  const added: TimelineEntry[] = [];
  const target = (op: TimelineOperation) => {
    if (op.index == null || !Number.isInteger(op.index) || !next[op.index]) {
      throw new Error(`Index invalide ou déjà supprimé : ${op.index}`);
    }
    return op.index;
  };
  for (const op of operations) {
    if (op.action === 'delete') {
      next[target(op)] = null;
    } else if (op.action === 'update') {
      const i = target(op);
      const entry = { ...next[i]! };
      if (op.timecodeSec != null) entry.timecodeSec = op.timecodeSec;
      if (op.endSec != null) entry.endSec = op.endSec;
      if (op.text != null) entry.text = op.text;
      next[i] = normalizeEntry(entry);
    } else if (op.action === 'add') {
      added.push(normalizeEntry(op));
    } else {
      throw new Error(`Action inconnue : ${String(op.action)}`);
    }
  }
  return [...next.filter((e): e is TimelineEntry => e !== null), ...added];
}

interface Replacement {
  find: string;
  replace: string;
  fromSec?: number;
  toSec?: number;
}

function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/’/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}']+/gu, '');
}

/** Applique un remplacement en place ; renvoie le nombre d'occurrences. */
function replaceInWords(words: Word[], r: Replacement): number {
  const tokens = r.find.split(/\s+/).map(normalizeToken).filter(Boolean);
  const replacementTokens = r.replace.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('find vide');
  if (!replacementTokens.length) throw new Error('replace vide');

  const positions = words
    .map((w, i) => (w.type === 'word' ? i : -1))
    .filter((i) => i >= 0);
  const inRange = (w: Word) =>
    (r.fromSec == null || (w.start ?? 0) >= r.fromSec) &&
    (r.toSec == null || (w.start ?? 0) <= r.toSec);

  const matches: number[][] = [];
  for (let k = 0; k + tokens.length <= positions.length; k++) {
    const slice = positions.slice(k, k + tokens.length);
    if (
      inRange(words[slice[0]]) &&
      slice.every((p, j) => normalizeToken(words[p].text) === tokens[j])
    ) {
      matches.push(slice);
      k += tokens.length - 1;
    }
  }

  // De la fin vers le début : les suppressions ne décalent pas les matches restants.
  for (const slice of matches.reverse()) {
    const first = words[slice[0]];
    const last = words[slice[slice.length - 1]];
    const punctuation = last.text.match(/[.,!?…;:]+$/)?.[0] ?? '';
    const withPunctuation = (text: string) =>
      punctuation && !/[.,!?…;:]$/.test(text) ? text + punctuation : text;

    if (replacementTokens.length === slice.length) {
      slice.forEach((p, j) => {
        words[p].text =
          j === slice.length - 1
            ? withPunctuation(replacementTokens[j])
            : replacementTokens[j];
      });
      continue;
    }
    first.text = withPunctuation(replacementTokens.join(' '));
    first.end = last.end ?? first.end;
    // Retire les mots fusionnés et les espacements entre eux (on garde les
    // événements audio).
    for (let p = slice[slice.length - 1]; p > slice[0]; p--) {
      if (words[p].type !== 'audio_event') words.splice(p, 1);
    }
  }
  return matches.length;
}

async function saveWords(recordingId: number, words: Word[]): Promise<void> {
  await pool.query(
    `UPDATE transcriptions
     SET original_words_json = COALESCE(original_words_json, words_json), words_json = ?
     WHERE recording_id = ?`,
    [JSON.stringify(words), recordingId],
  );
}

interface TurnState {
  recordingId: number;
  analysis: AnalysisRow | null;
  timeline: Timeline | null;
  words: Word[];
  actions: ChatAction[];
}

async function runTool(
  state: TurnState,
  name: string,
  input: unknown,
): Promise<string> {
  if (name === 'update_timeline') {
    if (!state.analysis || !state.timeline) {
      throw new Error('Pas de timeline à modifier (analyse non terminée)');
    }
    const { operations } = input as { operations?: TimelineOperation[] };
    if (!Array.isArray(operations) || !operations.length) {
      throw new Error('operations manquant');
    }
    const entries = applyTimelineOperations(state.timeline.entries, operations);
    state.timeline = await saveTimelineEntries(state.analysis, entries);
    // L'analyse relue porte la nouvelle timeline pour les appels suivants.
    state.analysis = { ...state.analysis, timeline_json: JSON.stringify(state.timeline) };
    const counts = { update: 0, delete: 0, add: 0 };
    for (const op of operations) counts[op.action]++;
    const parts = [
      counts.update && `${counts.update} modifiée(s)`,
      counts.add && `${counts.add} ajoutée(s)`,
      counts.delete && `${counts.delete} supprimée(s)`,
    ].filter(Boolean);
    state.actions.push({ type: 'timeline', summary: `Timeline : ${parts.join(', ')}` });
    return `Timeline enregistrée. Nouvelle version :\n${formatTimeline(state.timeline)}`;
  }

  if (name === 'edit_transcript') {
    const { replacements } = input as { replacements?: Replacement[] };
    if (!Array.isArray(replacements) || !replacements.length) {
      throw new Error('replacements manquant');
    }
    const report: string[] = [];
    let total = 0;
    for (const r of replacements) {
      const count = replaceInWords(state.words, r);
      total += count;
      report.push(`« ${r.find} » → « ${r.replace} » : ${count} occurrence(s)`);
    }
    if (total > 0) {
      await saveWords(state.recordingId, state.words);
      state.actions.push({
        type: 'transcript',
        summary: `Transcription : ${total} correction(s)`,
      });
    }
    return report.join('\n');
  }

  if (name === 'update_band_context') {
    const { content } = input as { content?: string };
    if (typeof content !== 'string') throw new Error('content manquant');
    await setBandContext(content);
    state.actions.push({ type: 'context', summary: 'Contexte du groupe mis à jour' });
    return 'Contexte du groupe enregistré.';
  }

  throw new Error(`Outil inconnu : ${name}`);
}

// --- Tour de conversation ---------------------------------------------------

export interface PendingTurn {
  content: string;
  authorEmail: string;
  error: string | null;
}

// Un tour peut durer bien plus qu'un timeout de reverse proxy (première
// lecture de la transcription, plusieurs allers-retours d'outils) : il tourne
// en tâche de fond, suivi par polling comme l'analyse. Un seul tour à la fois
// par enregistrement — deux corrections en parallèle s'écraseraient. Un tour
// en échec reste affiché (avec son erreur) jusqu'au message suivant.
const turns = new Map<number, PendingTurn>();

export function pendingTurn(recordingId: number): PendingTurn | null {
  return turns.get(recordingId) ?? null;
}

export function startChatTurn(
  recordingId: number,
  authorEmail: string,
  rawText: string,
): PendingTurn {
  const text = rawText.trim();
  if (!text) throw new HttpError(400, 'Message vide');
  if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, 'Message trop long');
  const current = turns.get(recordingId);
  if (current && !current.error) {
    throw new HttpError(409, 'Une réponse est déjà en cours pour cet enregistrement');
  }

  const turn: PendingTurn = { content: text, authorEmail, error: null };
  turns.set(recordingId, turn);
  setImmediate(async () => {
    try {
      await runChatTurn(recordingId, authorEmail, text);
      turns.delete(recordingId);
    } catch (err) {
      console.error(`[chat #${recordingId}] échec :`, err);
      turn.error =
        err instanceof HttpError ? err.message : 'Le chat n’a pas pu répondre, réessaie.';
    }
  });
  return turn;
}

async function runChatTurn(
  recordingId: number,
  authorEmail: string,
  text: string,
): Promise<void> {
  const recording = await getRecordingOrThrow(recordingId);
  const words = await loadWords(recordingId);
  const analysis = await latestAnalysis(recordingId);
  const done = analysis?.status === 'done' && analysis.timeline_json ? analysis : null;
  const state: TurnState = {
    recordingId,
    analysis: done,
    timeline: done ? (JSON.parse(done.timeline_json!) as Timeline) : null,
    words,
    actions: [],
  };

  const transcript = buildTranscript(words, detectMusicSpans(words, () => {}));
  const system = systemPrompt(recording.filename, await getBandContext(), transcript);

  const history = (await listChatMessages(recordingId)).slice(-HISTORY_LIMIT);
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({
    role: m.role,
    content:
      m.content +
      (m.actions.length
        ? `\n\n[Actions effectuées : ${m.actions.map((a) => a.summary).join(' ; ')}]`
        : ''),
  }));
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `Timeline actuelle :\n${formatTimeline(state.timeline)}` },
      { type: 'text', text },
    ],
  });

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const replyParts: string[] = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.beta.messages.create({
      model: CHAT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: FALLBACK_MODEL }],
      output_config: { effort: 'medium' },
      // La transcription (gros préfixe stable) est mise en cache entre les tours.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: TOOLS,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) replyParts.push(block.text.trim());
    }

    if (response.stop_reason === 'refusal') {
      replyParts.push('(Je ne peux pas répondre à cette demande.)');
      break;
    }
    if (response.stop_reason === 'max_tokens') {
      replyParts.push('(Réponse tronquée.)');
      break;
    }
    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      try {
        const output = await runTool(state, block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  const reply =
    replyParts.join('\n\n') ||
    (state.actions.length ? 'C’est fait.' : '(Pas de réponse.)');
  // Enregistrés seulement une fois la réponse obtenue : un échec d'API ne
  // laisse pas de question orpheline dans la conversation.
  await insertMessage(recordingId, 'user', text, authorEmail);
  await insertMessage(
    recordingId,
    'assistant',
    reply,
    null,
    state.actions,
  );
  console.log(
    `[chat #${recordingId}] ${authorEmail} — ${state.actions.map((a) => a.summary).join(' ; ') || 'pas d’action'}`,
  );
}
