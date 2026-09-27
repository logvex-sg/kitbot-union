import { describe, expect, it } from 'vitest';
import {
  associateSignsWithContainers,
  effectiveKitId,
  matchKitBySign,
  parseWebhookEventKinds,
  safeHost,
  signCandidates,
  type KitAliasEntry,
} from '@unionkitbot/shared';

/**
 * Sign-based kit recognition is player-facing input, so the tests focus on the conservative
 * behaviour: a definite match, or nothing. A wrong answer here mislabels real storage.
 */
describe('sign kit recognition', () => {
  const kits: KitAliasEntry[] = [
    { kitId: 'pvp', aliases: ['pvp', 'pvp kit', 'combat'] },
    { kitId: 'starter', aliases: ['starter', 'start'] },
    { kitId: 'builder', aliases: ['builder', 'build'] },
  ];

  it('matches a kit from a single sign line', () => {
    const result = matchKitBySign(signCandidates(['PVP']), kits);
    expect(result.matched).toBe(true);
    expect(result.kitId).toBe('pvp');
    expect(result.ambiguous).toBe(false);
  });

  it('matches across lines when the label is split', () => {
    const result = matchKitBySign(signCandidates(['PVP', 'KIT']), kits);
    expect(result.matched).toBe(true);
    expect(result.kitId).toBe('pvp');
  });

  it('ignores colour and formatting codes', () => {
    const result = matchKitBySign(signCandidates(['\u00a7aStarter\u00a7r']), kits);
    expect(result.matched).toBe(true);
    expect(result.kitId).toBe('starter');
  });

  it('reports no match for unknown text instead of guessing', () => {
    const result = matchKitBySign(signCandidates(['random chest']), kits);
    expect(result.matched).toBe(false);
    expect(result.kitId).toBeNull();
    expect(result.reason).toContain('no configured kit alias matched');
  });

  it('reports ambiguity when one sign matches two kits', () => {
    const ambiguousKits: KitAliasEntry[] = [
      { kitId: 'a', aliases: ['shared'] },
      { kitId: 'b', aliases: ['shared'] },
    ];
    const result = matchKitBySign(signCandidates(['shared']), ambiguousKits);
    expect(result.matched).toBe(false);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty sign', () => {
    const result = matchKitBySign(signCandidates(['', '   ']), kits);
    expect(result.matched).toBe(false);
    expect(result.ambiguous).toBe(false);
  });
});

describe('sign to container association', () => {
  it('associates an adjacent sign with a container once', () => {
    const containers = [{ groupKey: 'g1', x: 10, y: 64, z: 10 }];
    const signs = [{ x: 11, y: 64, z: 10, lines: ['PVP'], attachedTo: { x: 10, y: 64, z: 10 } }];
    const result = associateSignsWithContainers(containers, signs);
    expect(result.get('g1')?.sign.lines[0]).toBe('PVP');
  });

  it('ignores a sign that is too far away', () => {
    const containers = [{ groupKey: 'g1', x: 10, y: 64, z: 10 }];
    const signs = [{ x: 30, y: 64, z: 30, lines: ['PVP'] }];
    expect(associateSignsWithContainers(containers, signs, 2.5).size).toBe(0);
  });

  it('never assigns one sign to two containers', () => {
    const containers = [
      { groupKey: 'g1', x: 10, y: 64, z: 10 },
      { groupKey: 'g2', x: 11, y: 64, z: 10 },
    ];
    const signs = [{ x: 10, y: 65, z: 10, lines: ['PVP'] }];
    const result = associateSignsWithContainers(containers, signs);
    expect(result.size).toBe(1);
  });
});

describe('manual mapping override', () => {
  it('prefers the override when enabled', () => {
    expect(effectiveKitId('detected', 'override', true)).toBe('override');
  });

  it('falls back to detection when the override is disabled', () => {
    expect(effectiveKitId('detected', 'override', false)).toBe('detected');
  });

  it('falls back to detection when no override kit is set', () => {
    expect(effectiveKitId('detected', null, true)).toBe('detected');
  });
});

describe('webhook configuration', () => {
  it('keeps recognised event kinds', () => {
    expect(parseWebhookEventKinds(['bot_death', 'critical_error'])).toEqual([
      'bot_death',
      'critical_error',
    ]);
  });

  it('drops unrecognised kinds rather than widening the allow-list', () => {
    expect(parseWebhookEventKinds(['bot_death', 'not_a_real_event'])).toEqual(['bot_death']);
  });

  it('de-duplicates and normalises case', () => {
    expect(parseWebhookEventKinds(['BOT_DEATH', 'bot_death'])).toEqual(['bot_death']);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(parseWebhookEventKinds(['', '  '])).toEqual([]);
  });

  it('exposes only the host of a webhook URL', () => {
    const url = 'https://discord.com/api/webhooks/123/SECRET-TOKEN-VALUE';
    expect(safeHost(url)).toBe('discord.com');
    expect(safeHost(url)).not.toContain('SECRET-TOKEN-VALUE');
    expect(safeHost(null)).toBeNull();
    expect(safeHost('not a url')).toBeNull();
  });
});
