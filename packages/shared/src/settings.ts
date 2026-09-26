import type { AgentSettings } from './types.js';

/** Deep-merges a partial settings patch onto a base AgentSettings object. */
export function mergeAgentSettings(base: AgentSettings, patch: unknown): AgentSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Partial<AgentSettings>;
  return {
    reconnect: { ...base.reconnect, ...(p.reconnect ?? {}) },
    navigation: { ...base.navigation, ...(p.navigation ?? {}) },
    storage: { ...base.storage, ...(p.storage ?? {}) },
    chat: { ...base.chat, ...(p.chat ?? {}) },
    delivery: { ...base.delivery, ...(p.delivery ?? {}) },
    tpa: { ...base.tpa, ...(p.tpa ?? {}) },
  };
}
