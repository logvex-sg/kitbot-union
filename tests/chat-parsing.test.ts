import { describe, expect, it } from 'vitest';
import { classifyChat, validateLlmClassification, stripFormatting } from '@unionkitbot/shared';

describe('chat parsing', () => {
  it('strips legacy section formatting codes', () => {
    expect(stripFormatting('\u00a7aHello \u00a7lworld')).toBe('Hello world');
    expect(stripFormatting('\u001b[31mred\u001b[0m')).toBe('red');
  });

  it('classifies tpa requests deterministically', () => {
    expect(classifyChat('Steve wants to teleport to you').eventType).toBe('TPA_REQUEST');
    expect(classifyChat('Alex requested tpa').eventType).toBe('TPA_REQUEST');
    expect(classifyChat('Steve wants to teleport to you').player).toBe('Steve');
  });

  it('classifies delivery requests', () => {
    expect(classifyChat('Steve: kit please').eventType).toBe('DELIVERY_REQUEST');
    expect(classifyChat('give me a kit').eventType).toBe('DELIVERY_REQUEST');
  });

  it('classifies greetings, deaths, disconnects and server messages', () => {
    expect(classifyChat('hello there').eventType).toBe('GREETING');
    expect(classifyChat('Steve was slain by Zombie').eventType).toBe('DEATH');
    expect(classifyChat('Steve left the game').eventType).toBe('DISCONNECT');
    expect(classifyChat('[Server] restarting soon').eventType).toBe('SERVER_MESSAGE');
  });

  it('extracts coordinates from chat lines', () => {
    const parsed = classifyChat('Steve wants to teleport to you at 120, 64, -45');
    expect(parsed.coordinates).toEqual({ x: 120, y: 64, z: -45 });
  });

  it('falls back to UNKNOWN for unmatched text', () => {
    const parsed = classifyChat('the quick brown fox');
    expect(parsed.eventType).toBe('UNKNOWN');
    expect(parsed.confidence).toBeLessThan(1);
  });
});

describe('llm classification validation', () => {
  it('accepts a grounded, confident classification', () => {
    const result = validateLlmClassification('Steve is asking to be teleported in', {
      eventType: 'TPA_REQUEST',
      player: 'Steve',
      confidence: 0.92,
    });
    expect(result).not.toBeNull();
    expect(result?.eventType).toBe('TPA_REQUEST');
    expect(result?.player).toBe('Steve');
    expect(result?.payload['source']).toBe('llm');
  });

  it('rejects an unknown or invalid event type', () => {
    expect(
      validateLlmClassification('hi', { eventType: 'DROP_EVERYTHING', confidence: 1 }),
    ).toBeNull();
    expect(validateLlmClassification('hi', { eventType: 'UNKNOWN', confidence: 1 })).toBeNull();
  });

  it('rejects low confidence or missing confidence', () => {
    expect(
      validateLlmClassification('hello', { eventType: 'GREETING', confidence: 0.4 }),
    ).toBeNull();
    expect(validateLlmClassification('hello', { eventType: 'GREETING' })).toBeNull();
  });

  it('rejects a hallucinated player name not present in the message', () => {
    expect(
      validateLlmClassification('someone wants to teleport', {
        eventType: 'TPA_REQUEST',
        player: 'Notch',
        confidence: 1,
      }),
    ).toBeNull();
  });

  it('keeps deterministic classification authoritative over the llm', () => {
    // A line the rules already classify never reaches the LLM path.
    const deterministic = classifyChat('Steve wants to teleport to you');
    expect(deterministic.eventType).toBe('TPA_REQUEST');
    expect(deterministic.confidence).toBe(1);
  });

  describe('transport envelope handling', () => {
    it('classifies the message body and attributes the speaker', () => {
      // Vanilla renders player chat as "<Player> text"; the wrapper must not defeat the rules.
      const greeting = classifyChat('<Steve> hello');
      expect(greeting.eventType).toBe('GREETING');
      expect(greeting.player).toBe('Steve');

      const kit = classifyChat('<Steve> send me a kit');
      expect(kit.eventType).toBe('DELIVERY_REQUEST');
      expect(kit.player).toBe('Steve');

      const tpa = classifyChat('<Steve> wants to teleport to you');
      expect(tpa.eventType).toBe('TPA_REQUEST');
      expect(tpa.player).toBe('Steve');
    });

    it('attributes death and disconnect to the player, not the verb', () => {
      const death = classifyChat('<Steve> was slain by Zombie');
      expect(death.eventType).toBe('DEATH');
      expect(death.player).toBe('Steve');

      const quit = classifyChat('<Steve> left the game');
      expect(quit.eventType).toBe('DISCONNECT');
      expect(quit.player).toBe('Steve');
    });

    it('does not treat the envelope itself as a match', () => {
      const gibberish = classifyChat('<Steve> random gibberish');
      expect(gibberish.eventType).toBe('UNKNOWN');
      expect(gibberish.player).toBe('Steve');
    });

    it('reads coordinates from a wrapped message', () => {
      const parsed = classifyChat('<Steve> send me a kit at 120, 64, -30');
      expect(parsed.eventType).toBe('DELIVERY_REQUEST');
      expect(parsed.coordinates).toEqual({ x: 120, y: 64, z: -30 });
    });

    it('leaves unwrapped server lines alone', () => {
      const parsed = classifyChat('Server restarting in 5 minutes');
      expect(parsed.eventType).toBe('UNKNOWN');
      expect(parsed.player).toBeNull();
    });

    it('grounds llm validation on the body rather than the wrapper', () => {
      // "Notch" appears only in the wrapper, so a claimed speaker must still be rejected.
      expect(
        validateLlmClassification('<Steve> hello', {
          eventType: 'GREETING',
          player: 'Notch',
          confidence: 1,
        }),
      ).toBeNull();
      const accepted = validateLlmClassification('<Steve> hello there', {
        eventType: 'GREETING',
        player: 'Steve',
        confidence: 1,
      });
      expect(accepted?.player).toBe('Steve');
    });
  });
});
