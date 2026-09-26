import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@unionkitbot/shared';
import { Api } from './api';

export function useApi(api: Api) {
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(fn: (client: Api) => Promise<T>, fallback?: T): Promise<T | undefined> => {
      try {
        const result = await fn(api);
        setError(null);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'request failed');
        return fallback;
      }
    },
    [api],
  );

  return { run, error, setError };
}

/** Polls a loader on an interval; keeps the last good value when a poll fails. */
export function usePoll<T>(
  loader: () => Promise<T | undefined>,
  intervalMs: number,
  deps: unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async () => {
    const result = await loaderRef.current();
    if (result !== undefined) setData(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    if (intervalMs <= 0) return undefined;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, refresh, ...deps]);

  return { data, loading, refresh, setData };
}

export interface LiveState {
  events: AgentEvent[];
  connected: boolean;
}

/** WebSocket subscription to the API event stream, with automatic reconnection. */
export function useLiveEvents(baseUrl: string, token: string): LiveState {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!token) return undefined;
    let socket: WebSocket | null = null;
    let timer: number | null = null;
    let closed = false;

    const connect = (): void => {
      const wsBase = baseUrl.replace(/^http/, 'ws');
      const url = `${wsBase}/api/ws?token=${encodeURIComponent(token)}`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current += 1;
        timer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => setConnected(false);
      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as {
            type?: string;
            event?: AgentEvent;
            recent?: AgentEvent[];
          };
          if (payload.type === 'hello' && Array.isArray(payload.recent)) {
            setEvents(payload.recent.slice(-200));
            return;
          }
          if (payload.event) {
            setEvents((current) => {
              const next = [...current, payload.event as AgentEvent];
              return next.length > 500 ? next.slice(-500) : next;
            });
          }
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, [baseUrl, token]);

  return { events, connected };
}
