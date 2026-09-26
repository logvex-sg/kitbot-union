import type { ChatEventType, ParsedChat, Vec3 } from './types.js';

export const DEFAULT_CHAT_PATTERNS = {
  tpa: [
    /^(?<player>\w{3,16})\s+(?:wants|would like)\s+to\s+teleport\s+to\s+you/i,
    /^(?<player>\w{3,16})\s+requested\s+(?:a\s+)?tpa(?:\s+to\s+you)?/i,
    /^\[?(?<player>\w{3,16})\]?\s*(?:has\s+)?requested\s+teleport/i,
    /^(?<player>\w{3,16})\s+(?:requests|is requesting)\s+(?:to\s+teleport|tpa)/i,
  ],
  delivery: [
    /^(?<player>\w{3,16})[\s:,-]+(?:kit|deliver|send)\b(?<rest>.*)$/i,
    /^(?:please\s+)?(?:send|give)\s+me\s+(?:a\s+)?kit\b(?<rest>.*)$/i,
  ],
  greeting: [
    /^(?:hi|hello|hey|yo|sup|good\s+(?:morning|evening|afternoon))\b[\s!.,]*(?<rest>.*)$/i,
  ],
  death: [
    /^(?<player>\w{3,16})\s+(?:was\s+)?(?:slain|killed|shot|blown up|burned|drowned|fell|died|withered|starved|suffocated|hit the ground)/i,
    /^(?<player>\w{3,16})\s+died/i,
  ],
  disconnect: [/^(?<player>\w{3,16})\s+(?:left|disconnected|quit)\s+the\s+game/i],
  server: [/^\[(?:Server|SERVER)\]/i, /^<Server>/i, /^\*+\s+/],
} as const;

export function stripFormatting(text: string): string {
  return (
    text
      .replace(/\u00a7[0-9a-fk-or]/gi, '')
      // eslint-disable-next-line no-control-regex -- matching the ESC byte is the point here
      .replace(/\u001b\[[0-9;]*m/g, '')
      .trim()
  );
}

export interface ChatEnvelope {
  player: string | null;
  message: string;
}

/**
 * Splits the transport wrapper players and servers actually use from the message body.
 * Vanilla renders player chat as `<Player> text` and servers commonly use `Player: text`
 * or `Player > text`; classification rules must see the body, not the wrapper.
 */
const CHAT_ENVELOPE_PATTERNS: RegExp[] = [
  /^<(?<player>[^<>]{1,32})>\s*(?<message>.*)$/,
  /^(?<player>[A-Za-z0-9_]{3,16})\s*(?:»|>|:)\s+(?<message>.+)$/,
];

export function parseChatEnvelope(text: string): ChatEnvelope {
  for (const pattern of CHAT_ENVELOPE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.groups) continue;
    const player = match.groups['player'];
    const message = match.groups['message'];
    if (player && message !== undefined) return { player, message: message.trim() };
  }
  return { player: null, message: text };
}

/**
 * Rules for the message body once the speaker is already known. The player-aware rules
 * below cannot be reused here: applied to a body like "was slain by Zombie" they capture
 * the verb itself ("was") as the speaker, which is why speaker attribution is handled by
 * the envelope and these rules only decide the event type.
 */
export const BODY_CHAT_PATTERNS = {
  tpa: [
    /^(?:wants|would like)\s+to\s+teleport\s+to\s+you\b/i,
    /^requested\s+(?:a\s+)?tpa(?:\s+to\s+you)?\b/i,
    /^(?:requests|is requesting|has requested)\s+(?:to\s+teleport|a\s+teleport|teleport|tpa)\b/i,
    /^(?:please\s+)?tpa\s+(?:me|to\s+me)\b/i,
  ],
  delivery: [
    /^(?:please\s+)?(?:send|give)\s+me\s+(?:a\s+)?kit\b(?<rest>.*)$/i,
    /^(?:kit|deliver|send)\b(?<rest>.*)$/i,
  ],
  death: [
    /^(?:was\s+)?(?:slain|killed|shot|blown up|burned|drowned|fell|died|withered|starved|suffocated|hit the ground|tried to swim in lava)\b/i,
    /^died\b/i,
  ],
  disconnect: [/^(?:left|disconnected|quit)\s+the\s+game\b/i],
  join: [/^joined\s+the\s+game\b/i],
} as const;

function parseCoordinates(text: string): Vec3 | null {
  const match = text.match(
    /(-?\d+(?:\.\d+)?)\s*[, /]\s*(-?\d+(?:\.\d+)?)\s*[, /]\s*(-?\d+(?:\.\d+)?)/,
  );
  if (!match) return null;
  const [, x, y, z] = match;
  if (x === undefined || y === undefined || z === undefined) return null;
  return { x: Number(x), y: Number(y), z: Number(z) };
}

/**
 * Deterministic chat classifier. Rules run in fixed priority order; unmatched lines
 * become UNKNOWN and may be escalated to the optional LLM classifier.
 */
export function classifyChat(rawMessage: string): ParsedChat {
  const text = stripFormatting(rawMessage);
  const envelope = parseChatEnvelope(text);
  // Rules match against the message body; the transport wrapper only supplies the player.
  const body = envelope.player ? envelope.message : text;
  const coords = parseCoordinates(body);
  const groupsOf = (m: RegExpExecArray): Record<string, string | undefined> =>
    (m.groups ?? {}) as Record<string, string | undefined>;

  // When the speaker is known, the body rules decide the event type; speaker-aware rules
  // would otherwise capture the leading verb as the player name.
  if (envelope.player) {
    for (const pattern of BODY_CHAT_PATTERNS.tpa) {
      if (pattern.test(body)) {
        return {
          eventType: 'TPA_REQUEST',
          player: envelope.player,
          coordinates: coords,
          payload: {},
          confidence: 1,
        };
      }
    }
    for (const pattern of BODY_CHAT_PATTERNS.delivery) {
      const m = pattern.exec(body);
      if (m) {
        return {
          eventType: 'DELIVERY_REQUEST',
          player: envelope.player,
          coordinates: coords,
          payload: { rest: groupsOf(m)['rest']?.trim() ?? '' },
          confidence: 1,
        };
      }
    }
    for (const pattern of BODY_CHAT_PATTERNS.death) {
      if (pattern.test(body)) {
        return {
          eventType: 'DEATH',
          player: envelope.player,
          coordinates: coords,
          payload: {},
          confidence: 0.9,
        };
      }
    }
    for (const pattern of BODY_CHAT_PATTERNS.disconnect) {
      if (pattern.test(body)) {
        return {
          eventType: 'DISCONNECT',
          player: envelope.player,
          coordinates: null,
          payload: {},
          confidence: 0.9,
        };
      }
    }
  }

  for (const pattern of DEFAULT_CHAT_PATTERNS.tpa) {
    const m = pattern.exec(body);
    if (m) {
      return {
        eventType: 'TPA_REQUEST',
        player: groupsOf(m)['player'] ?? envelope.player,
        coordinates: coords,
        payload: { rest: groupsOf(m)['rest'] ?? '' },
        confidence: 1,
      };
    }
  }
  for (const pattern of DEFAULT_CHAT_PATTERNS.delivery) {
    const m = pattern.exec(body);
    if (m) {
      const groups = groupsOf(m);
      return {
        eventType: 'DELIVERY_REQUEST',
        player: groups['player'] ?? envelope.player,
        coordinates: coords,
        payload: { rest: groups['rest']?.trim() ?? '' },
        confidence: groups['player'] ? 1 : 0.7,
      };
    }
  }
  for (const pattern of DEFAULT_CHAT_PATTERNS.death) {
    const m = pattern.exec(body);
    if (m) {
      return {
        eventType: 'DEATH',
        player: groupsOf(m)['player'] ?? null,
        coordinates: coords,
        payload: {},
        confidence: 0.9,
      };
    }
  }
  for (const pattern of DEFAULT_CHAT_PATTERNS.disconnect) {
    const m = pattern.exec(body);
    if (m) {
      return {
        eventType: 'DISCONNECT',
        player: groupsOf(m)['player'] ?? envelope.player,
        coordinates: null,
        payload: {},
        confidence: 0.9,
      };
    }
  }
  for (const pattern of DEFAULT_CHAT_PATTERNS.server) {
    if (pattern.test(body)) {
      return {
        eventType: 'SERVER_MESSAGE',
        player: null,
        coordinates: coords,
        payload: {},
        confidence: 0.8,
      };
    }
  }
  for (const pattern of DEFAULT_CHAT_PATTERNS.greeting) {
    if (pattern.test(body)) {
      return {
        eventType: 'GREETING',
        player: envelope.player,
        coordinates: null,
        payload: {},
        confidence: 0.8,
      };
    }
  }
  if (envelope.player) {
    // A recognised player spoke, but nothing in the deterministic rules matched.
    return {
      eventType: 'UNKNOWN',
      player: envelope.player,
      coordinates: coords,
      payload: {},
      confidence: 0.5,
    };
  }
  return { eventType: 'UNKNOWN', player: null, coordinates: coords, payload: {}, confidence: 0.3 };
}

/**
 * Accepts an LLM classification only when it is well formed and grounded in the original
 * chat line. LLM output is never allowed to trigger Minecraft actions directly.
 */
export function validateLlmClassification(
  rawMessage: string,
  candidate: { eventType?: string; player?: string | null; confidence?: number },
): ParsedChat | null {
  const allowed: ChatEventType[] = [
    'TPA_REQUEST',
    'DELIVERY_REQUEST',
    'GREETING',
    'SERVER_MESSAGE',
    'DEATH',
    'DISCONNECT',
    'UNKNOWN',
  ];
  if (!candidate.eventType || !allowed.includes(candidate.eventType as ChatEventType)) return null;
  if (candidate.eventType === 'UNKNOWN') return null;
  const confidence = candidate.confidence ?? 0;
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0.7) return null;
  const text = stripFormatting(rawMessage);
  const envelope = parseChatEnvelope(text);
  const body = envelope.player ? envelope.message : text;
  if (envelope.player) {
    // The wrapper's speaker comes from the server, so it is authoritative: an LLM that
    // names a different player is hallucinating and the classification is discarded.
    if (candidate.player && candidate.player !== envelope.player) return null;
  } else if (
    candidate.player &&
    !body.toLowerCase().includes(candidate.player.toLowerCase())
  ) {
    return null;
  }
  return {
    eventType: candidate.eventType as ChatEventType,
    player: candidate.player ?? envelope.player,
    coordinates: parseCoordinates(body),
    payload: { source: 'llm' },
    confidence,
  };
}
