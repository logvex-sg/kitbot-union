import { BOT_STATES, type BotState } from './types.js';

/** Explicit lifecycle transition table. Unlisted transitions are refused. */
export const ALLOWED_TRANSITIONS: Record<BotState, readonly BotState[]> = {
  OFFLINE: ['CONNECTING', 'IDLE', 'ERROR'],
  CONNECTING: ['SPAWNING', 'DISCONNECTED', 'OFFLINE', 'ERROR', 'RECOVERING'],
  SPAWNING: ['IDLE', 'DISCONNECTED', 'DEAD', 'ERROR', 'RECOVERING'],
  IDLE: [
    'NAVIGATING',
    'DELIVERING',
    'SCANNING',
    'CONNECTING',
    'DISCONNECTED',
    'DEAD',
    'RECOVERING',
    'OFFLINE',
    'ERROR',
    'SPAWNING',
  ],
  NAVIGATING: [
    'IDLE',
    'DELIVERING',
    'SCANNING',
    'NAVIGATING',
    'DISCONNECTED',
    'DEAD',
    'RECOVERING',
    'ERROR',
  ],
  DELIVERING: [
    'IDLE',
    'NAVIGATING',
    'SCANNING',
    'DELIVERING',
    'DISCONNECTED',
    'DEAD',
    'RECOVERING',
    'ERROR',
  ],
  SCANNING: ['IDLE', 'NAVIGATING', 'DELIVERING', 'DISCONNECTED', 'DEAD', 'RECOVERING', 'ERROR'],
  RECOVERING: ['CONNECTING', 'IDLE', 'OFFLINE', 'DISCONNECTED', 'DEAD', 'ERROR', 'RECOVERING'],
  DISCONNECTED: ['CONNECTING', 'RECOVERING', 'OFFLINE', 'ERROR', 'DEAD'],
  DEAD: ['RECOVERING', 'CONNECTING', 'OFFLINE', 'DISCONNECTED', 'ERROR'],
  ERROR: ['RECOVERING', 'CONNECTING', 'OFFLINE', 'IDLE', 'ERROR'],
};

export function isValidTransition(from: BotState, to: BotState): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface StateChange {
  from: BotState;
  to: BotState;
  reason: string;
  at: number;
}

export class StateMachine {
  private state: BotState;
  private readonly history: StateChange[] = [];
  private readonly listeners = new Set<(change: StateChange) => void>();

  constructor(initial: BotState = 'OFFLINE') {
    if (!BOT_STATES.includes(initial)) throw new Error(`Unknown bot state: ${initial}`);
    this.state = initial;
  }

  get current(): BotState {
    return this.state;
  }
  getHistory(limit = 50): StateChange[] {
    return this.history.slice(-limit);
  }

  onChange(listener: (change: StateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canTransition(to: BotState): boolean {
    return isValidTransition(this.state, to);
  }

  private apply(to: BotState, reason: string): void {
    const change: StateChange = { from: this.state, to, reason, at: Date.now() };
    this.state = to;
    this.history.push(change);
    if (this.history.length > 500) this.history.shift();
    for (const listener of this.listeners) listener(change);
  }

  /** Returns true when applied; illegal transitions are refused rather than thrown. */
  transition(to: BotState, reason = ''): boolean {
    if (!isValidTransition(this.state, to)) return false;
    this.apply(to, reason);
    return true;
  }

  /** Deliberately bypasses the table for recovery paths. */
  force(to: BotState, reason = 'forced'): void {
    this.apply(to, reason);
  }
}
