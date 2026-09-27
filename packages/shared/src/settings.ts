import type { AgentSettings } from './types.js';

/**
 * Deep-merges a partial settings patch onto a base AgentSettings object.
 *
 * Unknown keys in the patch are ignored and known groups are merged field by field, so a
 * partial patch from the API, the UI or a bot record cannot drop sibling fields.
 */
export function mergeAgentSettings(base: AgentSettings, patch: unknown): AgentSettings {
  if (!patch || typeof patch !== 'object') return base;
  const p = patch as Partial<AgentSettings> & Record<string, unknown>;
  const delivery = p.delivery ?? ({} as Partial<AgentSettings['delivery']>);
  const postDelivery = delivery.postDelivery;
  return {
    reconnect: { ...base.reconnect, ...(p.reconnect ?? {}) },
    navigation: { ...base.navigation, ...(p.navigation ?? {}) },
    storage: { ...base.storage, ...(p.storage ?? {}) },
    chat: { ...base.chat, ...(p.chat ?? {}) },
    delivery: {
      ...base.delivery,
      ...delivery,
      postDelivery: { ...base.delivery.postDelivery, ...(postDelivery ?? {}) },
    },
    tpa: { ...base.tpa, ...(p.tpa ?? {}) },
    outgoingTpa: { ...base.outgoingTpa, ...(p.outgoingTpa ?? {}) },
    powerSaving: { ...base.powerSaving, ...(p.powerSaving ?? {}) },
    webhooks: {
      ...base.webhooks,
      ...(p.webhooks ?? {}),
      // A URL patch of null means "no webhook configured"; anything else replaces it.
      url:
        p.webhooks && 'url' in p.webhooks
          ? ((p.webhooks as { url?: string | null }).url ?? null)
          : base.webhooks.url,
    },
    linking: { ...base.linking, ...(p.linking ?? {}) },
    packArea:
      p.packArea === undefined
        ? base.packArea
        : p.packArea === null
          ? null
          : { ...(base.packArea ?? { waypointName: null, dimension: null }), ...p.packArea },
  };
}
