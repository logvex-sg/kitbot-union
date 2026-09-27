import type { Bot } from 'mineflayer';
import {
  classifyChat,
  validateLlmClassification,
  type ChatEventType,
  type Logger,
  type ParsedChat,
} from '@unionkitbot/shared';
import type { AgentEventEmitter } from '../events.js';

export interface LlmClassifier {
  classify(
    message: string,
  ): Promise<{ eventType?: string; player?: string | null; confidence?: number } | null>;
}

export interface ChatMessage {
  raw: string;
  parsed: ParsedChat;
  at: string;
  username: string | null;
}

export interface ChatServiceOptions {
  botId: string;
  logger: Logger;
  events: AgentEventEmitter;
  getBot: () => Bot | null;
  llm?: LlmClassifier;
}

/**
 * Deterministic chat parsing first. The optional LLM classifier is only consulted for
 * UNKNOWN lines, and its output must survive `validateLlmClassification` before use.
 */
export class ChatService {
  private readonly options: ChatServiceOptions;
  private readonly handlers = new Map<ChatEventType, Array<(message: ChatMessage) => void>>();
  private readonly recent: ChatMessage[] = [];
  private readonly rawHandlers = new Set<(line: string) => void>();

  constructor(options: ChatServiceOptions) {
    this.options = options;
  }

  on(eventType: ChatEventType, handler: (message: ChatMessage) => void): () => void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
    return () => {
      const current = this.handlers.get(eventType) ?? [];
      this.handlers.set(
        eventType,
        current.filter((h) => h !== handler),
      );
    };
  }

  history(limit = 100): ChatMessage[] {
    return this.recent.slice(-limit);
  }

  /**
   * Subscribes to every raw inbound line before classification.
   *
   * Used by the outgoing TPA requester, which must see the server's accept/reject reply
   * regardless of how the classifier labels it.
   */
  onRaw(handler: (line: string) => void): () => void {
    this.rawHandlers.add(handler);
    return () => {
      this.rawHandlers.delete(handler);
    };
  }

  say(message: string): void {
    const bot = this.options.getBot();
    if (bot) bot.chat(message);
  }

  /** Entry point wired to the mineflayer 'message' event. */
  async ingest(raw: string, username: string | null): Promise<ChatMessage> {
    for (const handler of this.rawHandlers) {
      try {
        handler(raw);
      } catch (error) {
        // A misbehaving observer must not stop chat ingestion for everyone else.
        this.options.logger.debug({ err: error }, 'raw chat handler threw');
      }
    }
    let parsed = classifyChat(raw);

    if (parsed.eventType === 'UNKNOWN' && this.options.llm) {
      try {
        const candidate = await this.options.llm.classify(raw);
        if (candidate) {
          const validated = validateLlmClassification(raw, candidate);
          if (validated) {
            parsed = validated;
            this.options.logger.debug({ raw, validated }, 'llm chat classification accepted');
          } else {
            this.options.logger.debug({ raw, candidate }, 'llm chat classification rejected');
          }
        }
      } catch (error) {
        this.options.logger.debug({ err: error }, 'llm classifier failed');
      }
    }

    const message: ChatMessage = {
      raw,
      parsed,
      at: new Date().toISOString(),
      username: parsed.player ?? username,
    };
    this.recent.push(message);
    if (this.recent.length > 500) this.recent.shift();

    this.options.events.emit(
      'bot:chat',
      raw,
      {
        eventType: parsed.eventType,
        player: message.username,
        confidence: parsed.confidence,
      },
      { botId: this.options.botId },
    );

    for (const handler of this.handlers.get(parsed.eventType) ?? []) {
      try {
        handler(message);
      } catch (error) {
        this.options.logger.error({ err: error }, 'chat handler threw');
      }
    }
    return message;
  }
}
