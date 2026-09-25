/**
 * The agent reaches the API over two transports at once: it publishes every event to Redis
 * and also pushes it down the control socket. Without dedupe the dashboard renders each
 * heartbeat, delivery step and death twice.
 */
import { describe, expect, it } from 'vitest';
import { EventHub } from '../apps/api/src/ws.js';
import { createLogger, type AgentEvent } from '@unionkitbot/shared';

const logger = createLogger({ name: 'hub-test', level: 'silent' });

function makeEvent(id: string, message = 'heartbeat'): AgentEvent {
  return {
    id,
    type: 'bot:heartbeat',
    botId: 'bot-1',
    at: new Date().toISOString(),
    severity: 'info',
    message,
    data: {},
  };
}

/** Builds a hub whose Redis subscriber is an inert stub; ingest() drives the test. */
function makeHub(): EventHub {
  const client = {
    duplicate: () => ({ subscribe: async () => undefined, on: () => undefined, quit: async () => undefined }),
  };
  const redis = {
    client,
    trackWsClient: async () => undefined,
    untrackWsClient: async () => undefined,
  };
  return new EventHub({
    logger,
    redis: redis as never,
    auth: { authenticateToken: () => null } as never,
    path: '/api/ws',
  });
}

describe('event hub deduplication', () => {
  it('broadcasts an event once when both transports deliver it', () => {
    const hub = makeHub();
    const event = makeEvent('dup-1');

    hub.ingest(event);
    hub.ingest(event);

    expect(hub.recentEvents().filter((e) => e.id === 'dup-1')).toHaveLength(1);
  });

  it('keeps distinct events with different ids', () => {
    const hub = makeHub();
    hub.ingest(makeEvent('a'));
    hub.ingest(makeEvent('b'));

    expect(hub.recentEvents().map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('bounds the dedupe memory by evicting the oldest ids', () => {
    const hub = makeHub();
    for (let i = 0; i < 2100; i += 1) hub.ingest(makeEvent(`id-${i}`));

    // The buffer is capped at 1000, so a very old event is gone and cannot be re-suppressed
    // by the id set either; a recent duplicate is still dropped.
    const recent = makeEvent('id-2099');
    hub.ingest(recent);
    expect(hub.recentEvents().filter((e) => e.id === 'id-2099')).toHaveLength(1);
  });
});
