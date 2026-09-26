/**
 * Authorization model for Discord commands. Both role and user allowlists are checked so a
 * server admin cannot grant control to a role that the deployment has not approved.
 */
export interface PermissionConfig {
  allowedUserIds: string[];
  allowedRoleIds: string[];
  /** When true, anyone in the guild may run read-only commands. */
  allowReadOnlyForEveryone: boolean;
}

export interface MemberLike {
  id: string;
  roles: string[] | { cache: { has: (id: string) => boolean } };
}

const READ_ONLY = new Set([
  'status',
  'inventory',
  'players',
  'tasks',
  'deliveries',
  'waypoints',
  'logs',
  'chat',
  'bots',
]);

export function isReadOnly(command: string): boolean {
  return READ_ONLY.has(command);
}

export function extractRoleIds(member: MemberLike | null | undefined): string[] {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  const cached = member.roles.cache;
  const ids: string[] = [];
  for (const [id, value] of cached as unknown as Map<string, unknown>) {
    void value;
    ids.push(id);
  }
  return ids;
}

/**
 * Returns whether the actor may execute the command. Mutating commands always require an
 * explicit user or role allowlist entry, regardless of guild permissions.
 */
export function canExecute(
  command: string,
  member: MemberLike | null | undefined,
  config: PermissionConfig,
): { allowed: boolean; reason: string } {
  if (!member) return { allowed: false, reason: 'no guild member context' };
  const roles = extractRoleIds(member);
  const isAllowedUser = config.allowedUserIds.includes(member.id);
  const isAllowedRole = roles.some((role) => config.allowedRoleIds.includes(role));

  if (isAllowedUser || isAllowedRole) return { allowed: true, reason: 'allowlisted actor' };

  if (isReadOnly(command) && config.allowReadOnlyForEveryone) {
    return { allowed: true, reason: 'read-only command allowed for guild members' };
  }

  return {
    allowed: false,
    reason: 'actor is not an allowlisted user or role for this command',
  };
}
