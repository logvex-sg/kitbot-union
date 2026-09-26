import type { AgentEvent } from '@unionkitbot/shared';
import type { UnionKitDiscord } from './bot.js';

/** The notification channel is fed purely from agent events, so it always mirrors reality. */
export function wireNotifications(discord: UnionKitDiscord): (event: AgentEvent) => void {
  return (event: AgentEvent) => {
    void discord.handleAgentEvent(event);
  };
}
