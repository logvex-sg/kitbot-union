/**
 * Discord <-> Minecraft account linking.
 *
 * Only the relationship is stored. No Minecraft password, Microsoft credential or refresh
 * token is ever held here: authentication to the game stays with the agent's own
 * configured bot account, and a link is just a claim about who a Discord user is in game.
 */

export interface AccountLink {
  id: string;
  discordUserId: string;
  /** Lowercase Minecraft username as linked. */
  minecraftUsername: string;
  minecraftUuid: string | null;
  verified: boolean;
  /** How the link was established, for the audit trail. */
  method: 'command' | 'operator' | 'import';
  createdAt: string;
  updatedAt: string;
}

export interface LinkPolicy {
  /** When true a link starts unverified and cannot be used for delivery until approved. */
  requireConfirmation: boolean;
  /** Reject links whose username is not a plausible Minecraft name. */
  validateUsername: boolean;
  /** Allow a Minecraft username to be linked by only one Discord user. */
  uniqueMinecraftAccount: boolean;
  /** Allow a Discord user to hold more than one linked account. */
  allowMultiplePerDiscordUser: boolean;
}

export const DEFAULT_LINK_POLICY: LinkPolicy = {
  requireConfirmation: true,
  validateUsername: true,
  uniqueMinecraftAccount: true,
  allowMultiplePerDiscordUser: false,
};

/** Vanilla Minecraft usernames: 3-16 chars, letters, digits and underscore. */
export const MINECRAFT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

export interface LinkValidationResult {
  ok: boolean;
  reason: string;
  normalized: string;
}

/**
 * Validates a user-supplied Minecraft username before it is stored.
 *
 * This is deliberately format-only. Confirming that the account exists requires the
 * server's authentication model, so the agent marks the resulting delivery with the
 * resolved username and the existing delivery verification still decides whether the
 * right player received the items.
 */
export function validateMinecraftUsername(
  raw: unknown,
  policy: LinkPolicy = DEFAULT_LINK_POLICY,
): LinkValidationResult {
  const normalized = String(raw ?? '').trim();
  if (normalized.length === 0) {
    return { ok: false, reason: 'username is required', normalized };
  }
  if (!policy.validateUsername) {
    return { ok: true, reason: 'username validation disabled', normalized };
  }
  if (!MINECRAFT_USERNAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      reason: 'not a valid Minecraft username (3-16 letters, digits or underscore)',
      normalized,
    };
  }
  return { ok: true, reason: 'ok', normalized };
}

export interface LinkCheckInput {
  discordUserId: string;
  minecraftUsername: string;
  existing: readonly AccountLink[];
  policy?: LinkPolicy;
}

export type LinkDecision =
  | { action: 'create'; verified: boolean; reason: string }
  | { action: 'reject'; reason: string }
  | { action: 'replace'; replaceLinkId: string; verified: boolean; reason: string };

/**
 * Decides what linking a username should do for a given Discord user.
 *
 * The decision is separate from persistence so the rules are testable without a database,
 * and so the same logic governs the Discord command, the REST route and any import.
 */
export function decideLink(input: LinkCheckInput): LinkDecision {
  const policy = input.policy ?? DEFAULT_LINK_POLICY;
  const validation = validateMinecraftUsername(input.minecraftUsername, policy);
  if (!validation.ok) return { action: 'reject', reason: validation.reason };

  const username = validation.normalized.toLowerCase();
  const own = input.existing.filter((link) => link.discordUserId === input.discordUserId);
  const conflicting = input.existing.filter(
    (link) => link.minecraftUsername.toLowerCase() === username,
  );

  // Another Discord user already owns this Minecraft account.
  const foreignConflict = conflicting.find((link) => link.discordUserId !== input.discordUserId);
  if (foreignConflict && policy.uniqueMinecraftAccount) {
    return {
      action: 'reject',
      reason: 'that Minecraft account is already linked to another Discord user',
    };
  }

  if (own.some((link) => link.minecraftUsername.toLowerCase() === username)) {
    return {
      action: 'create',
      verified: own.find((link) => link.minecraftUsername.toLowerCase() === username)?.verified ?? false,
      reason: 'already linked to this Discord user; re-affirming the link',
    };
  }

  if (own.length > 0 && !policy.allowMultiplePerDiscordUser) {
    return {
      action: 'replace',
      replaceLinkId: own[0]!.id,
      verified: !policy.requireConfirmation,
      reason: 'replacing the existing linked account for this Discord user',
    };
  }

  return {
    action: 'create',
    verified: !policy.requireConfirmation,
    reason: policy.requireConfirmation
      ? 'link recorded; awaiting confirmation'
      : 'link recorded and verified',
  };
}

/** Resolves the linked Minecraft account a delivery should target. */
export function resolveRecipient(
  discordUserId: string | null,
  links: readonly AccountLink[],
): AccountLink | null {
  if (!discordUserId) return null;
  const own = links.filter((link) => link.discordUserId === discordUserId);
  if (own.length === 0) return null;
  return own.find((link) => link.verified) ?? null;
}

/** Discards credentials if a caller ever tries to persist them alongside a link. */
export function stripCredentialFields(input: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    'password',
    'microsoftPassword',
    'microsoftpassword',
    'accessToken',
    'accesstoken',
    'refreshToken',
    'refreshtoken',
    'clientSecret',
    'clientsecret',
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (blocked.has(key)) continue;
    out[key] = value;
  }
  return out;
}
