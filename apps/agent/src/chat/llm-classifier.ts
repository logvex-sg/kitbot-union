import type { Logger } from '@unionkitbot/shared';
import type { LlmClassifier } from '../chat/service.js';

export interface LlmClassifierConfig {
  enabled: boolean;
  apiBase?: string;
  apiKey?: string;
  model?: string;
}

const ALLOWED_EVENTS = [
  'TPA_REQUEST',
  'DELIVERY_REQUEST',
  'GREETING',
  'SERVER_MESSAGE',
  'DEATH',
  'DISCONNECT',
  'UNKNOWN',
];

const SYSTEM_PROMPT = [
  'You classify Minecraft chat lines. Respond with JSON only, no prose.',
  'Schema: {"eventType": one of ' +
    ALLOWED_EVENTS.join('|') +
    ', "player": string or null, "confidence": number 0..1}',
  'Only classify when you are confident the line is a direct request or event addressed to the bot.',
  'If unsure, return UNKNOWN. Never invent a player name that is not present in the line.',
].join(' ');

/**
 * Optional LLM fallback for ambiguous chat lines. Its output is never trusted directly:
 * `validateLlmClassification` in the shared package re-checks the event type, confidence
 * and that the player is grounded in the original message before anything is acted upon.
 */
export class HttpLlmClassifier implements LlmClassifier {
  constructor(
    private readonly config: LlmClassifierConfig,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.enabled && Boolean(this.config.apiBase) && Boolean(this.config.apiKey);
  }

  async classify(
    message: string,
  ): Promise<{ eventType?: string; player?: string | null; confidence?: number } | null> {
    if (!this.enabled) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${this.config.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model ?? 'gpt-4o-mini',
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: message },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.debug({ status: response.status }, 'llm classifier http error');
        return null;
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content) as {
        eventType?: string;
        player?: string | null;
        confidence?: number;
      };
      return parsed;
    } catch (error) {
      this.logger.debug({ err: error }, 'llm classifier request failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
