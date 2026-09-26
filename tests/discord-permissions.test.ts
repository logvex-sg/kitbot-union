import { describe, expect, it } from 'vitest';
import {
  canExecute,
  extractRoleIds,
  isReadOnly,
  type PermissionConfig,
} from '../apps/discord/src/permissions.js';

const config = (patch: Partial<PermissionConfig> = {}): PermissionConfig => ({
  allowedUserIds: ['admin-user'],
  allowedRoleIds: ['admin-role'],
  allowReadOnlyForEveryone: false,
  ...patch,
});

const member = (id: string, roles: string[] = []) => ({ id, roles });

describe('discord permissions', () => {
  it('recognises read-only commands', () => {
    for (const command of ['status', 'inventory', 'tasks', 'logs']) {
      expect(isReadOnly(command)).toBe(true);
    }
    for (const command of ['start', 'stop', 'restart', 'goto', 'deliver', 'say']) {
      expect(isReadOnly(command)).toBe(false);
    }
  });

  it('allows an allowlisted user to run mutating commands', () => {
    expect(canExecute('start', member('admin-user'), config()).allowed).toBe(true);
  });

  it('allows an allowlisted role to run mutating commands', () => {
    expect(canExecute('restart', member('random', ['admin-role']), config()).allowed).toBe(true);
  });

  it('denies mutating commands to unauthorised members even with read-only open', () => {
    const decision = canExecute(
      'stop',
      member('random'),
      config({ allowReadOnlyForEveryone: true }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('allowlisted');
  });

  it('denies read-only commands by default', () => {
    expect(canExecute('status', member('random'), config()).allowed).toBe(false);
  });

  it('allows read-only commands to anyone only when explicitly enabled', () => {
    expect(
      canExecute('status', member('random'), config({ allowReadOnlyForEveryone: true })).allowed,
    ).toBe(true);
  });

  it('denies when there is no guild member context', () => {
    const decision = canExecute('status', null, config({ allowReadOnlyForEveryone: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('guild member');
  });

  it('reads role ids from both array and cache-backed shapes', () => {
    expect(extractRoleIds({ id: 'u', roles: ['a', 'b'] })).toEqual(['a', 'b']);
    const cache = new Map<string, unknown>([
      ['role-1', {}],
      ['role-2', {}],
    ]);
    expect(
      extractRoleIds({
        id: 'u',
        roles: { cache: cache as unknown as { has: (id: string) => boolean } },
      }).sort(),
    ).toEqual(['role-1', 'role-2']);
  });
});
