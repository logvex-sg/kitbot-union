/** Typed-ish REST client. Every UI control goes through this module. */
export interface ApiOptions {
  baseUrl: string;
  token: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export type Json = Record<string, unknown>;

export class Api {
  constructor(private readonly options: ApiOptions) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? String((payload as { message: string }).message)
          : `request failed with status ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return payload as T;
  }

  health() {
    return this.request<Json>('GET', '/api/health');
  }
  bots() {
    return this.request<{ bots: Json[] }>('GET', '/api/bots');
  }
  bot(id: string) {
    return this.request<Json>('GET', `/api/bots/${id}`);
  }
  createBot(body: unknown) {
    return this.request<Json>('POST', '/api/bots', body);
  }
  updateBot(id: string, body: unknown) {
    return this.request<Json>('PATCH', `/api/bots/${id}`, body);
  }
  botSettings(id: string, body: unknown) {
    return this.request<Json>('POST', `/api/bots/${id}/settings`, body);
  }
  startBot(id: string) {
    return this.request<Json>('POST', `/api/bots/${id}/start`);
  }
  stopBot(id: string) {
    return this.request<Json>('POST', `/api/bots/${id}/stop`);
  }
  restartBot(id: string) {
    return this.request<Json>('POST', `/api/bots/${id}/restart`);
  }
  botCommand(id: string, command: string, args: string[] = []) {
    return this.request<Json>('POST', `/api/bots/${id}/command`, { command, args });
  }

  tasks(botId?: string) {
    return this.request<{ tasks: Json[] }>('GET', `/api/tasks${botId ? `?botId=${botId}` : ''}`);
  }
  createTask(body: unknown) {
    return this.request<Json>('POST', '/api/tasks', body);
  }
  cancelTask(id: string) {
    return this.request<Json>('POST', `/api/tasks/${id}/cancel`);
  }
  pauseTask(id: string) {
    return this.request<Json>('POST', `/api/tasks/${id}/pause`);
  }
  resumeTask(id: string) {
    return this.request<Json>('POST', `/api/tasks/${id}/resume`);
  }

  deliveries(botId?: string) {
    return this.request<{ deliveries: Json[] }>(
      'GET',
      `/api/deliveries${botId ? `?botId=${botId}` : ''}`,
    );
  }
  kits() {
    return this.request<{ kits: Json[] }>('GET', '/api/kits');
  }
  putKit(id: string, body: unknown) {
    return this.request<Json>('PUT', `/api/kits/${id}`, body);
  }
  deleteKit(id: string) {
    return this.request<Json>('DELETE', `/api/kits/${id}`);
  }

  waypoints(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request<{ waypoints: Json[] }>('GET', `/api/waypoints${qs ? `?${qs}` : ''}`);
  }
  createWaypoint(body: unknown) {
    return this.request<Json>('POST', '/api/waypoints', body);
  }
  updateWaypoint(id: string, body: unknown) {
    return this.request<Json>('PATCH', `/api/waypoints/${id}`, body);
  }
  deleteWaypoint(id: string) {
    return this.request<Json>('DELETE', `/api/waypoints/${id}`);
  }

  storageScans(botId?: string) {
    return this.request<{ scans: Json[] }>(
      'GET',
      `/api/storage/scans${botId ? `?botId=${botId}` : ''}`,
    );
  }
  events(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request<Json>('GET', `/api/events${qs ? `?${qs}` : ''}`);
  }
  logs(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request<Json>('GET', `/api/logs${qs ? `?${qs}` : ''}`);
  }
  chat(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request<Json>('GET', `/api/chat${qs ? `?${qs}` : ''}`);
  }
  players() {
    return this.request<{ players: Json[] }>('GET', '/api/players');
  }
  sessions() {
    return this.request<{ sessions: Json[] }>('GET', '/api/sessions');
  }
  discord() {
    return this.request<Json>('GET', '/api/discord');
  }
  live() {
    return this.request<{ events: Json[] }>('GET', '/api/live');
  }
}
