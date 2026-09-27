import { useEffect, useMemo, useState } from 'react';
import { Api } from './api';
import { useLiveEvents } from './hooks';
import { Dashboard } from './pages/Dashboard';
import { Bots } from './pages/Bots';
import { Automation } from './pages/Automation';
import { Tasks } from './pages/Tasks';
import { Players } from './pages/Players';
import { Deliveries } from './pages/Deliveries';
import { Orders } from './pages/Orders';
import { Waypoints } from './pages/Waypoints';
import { Inventory } from './pages/Inventory';
import { Storage } from './pages/Storage';
import { Chat } from './pages/Chat';
import { DiscordPage } from './pages/DiscordPage';
import { Logs } from './pages/Logs';
import { Events } from './pages/Events';
import { Settings } from './pages/Settings';

const PAGES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'bots', label: 'Bots' },
  { id: 'automation', label: 'Automation' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'players', label: 'Players' },
  { id: 'deliveries', label: 'Deliveries' },
  { id: 'orders', label: 'Orders' },
  { id: 'waypoints', label: 'Waypoints' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'storage', label: 'Storage' },
  { id: 'chat', label: 'Chat' },
  { id: 'discord', label: 'Discord' },
  { id: 'logs', label: 'Logs' },
  { id: 'events', label: 'Events' },
  { id: 'settings', label: 'Settings' },
] as const;

type PageId = (typeof PAGES)[number]['id'];

export function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem('ukb.token') ?? '');
  const [apiBase] = useState<string>(
    () => localStorage.getItem('ukb.apiBase') ?? window.location.origin,
  );
  const [page, setPage] = useState<PageId>(
    () => (localStorage.getItem('ukb.page') as PageId) ?? 'dashboard',
  );
  const [tokenDraft, setTokenDraft] = useState(token);
  const [loginError, setLoginError] = useState<string | null>(null);

  const api = useMemo(() => new Api({ baseUrl: apiBase, token }), [apiBase, token]);
  const live = useLiveEvents(apiBase, token);

  useEffect(() => {
    localStorage.setItem('ukb.page', page);
  }, [page]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void api
      .health()
      .then(() => {
        if (!cancelled) setLoginError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoginError(error instanceof Error ? error.message : 'authentication failed');
      });
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  const submitToken = () => {
    localStorage.setItem('ukb.token', tokenDraft);
    setToken(tokenDraft);
    setLoginError(null);
  };

  if (!token) {
    return (
      <div className="login">
        <div className="card login-card">
          <div className="brand">
            <span className="brand-dot" />
            <span>
              <div className="brand-name">UnionKitBot</div>
              <div className="brand-ui">unionkitbot.ui</div>
            </span>
          </div>
          <div className="field">
            <label>api base url</label>
            <input value={apiBase} readOnly />
          </div>
          <div className="field">
            <label>api token</label>
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitToken();
              }}
            />
          </div>
          <button className="primary" onClick={submitToken} disabled={tokenDraft.length === 0}>
            connect
          </button>
          {loginError ? <div className="error-text">{loginError}</div> : null}
          <div className="muted mono-sm" style={{ marginTop: 10 }}>
            The token is the API_SECRET configured on the backend. It is kept in this browser only.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>
            <div className="brand-name">UnionKitBot</div>
            <div className="brand-ui">unionkitbot.ui</div>
          </span>
        </div>
        {PAGES.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span>{item.label}</span>
            {item.id === 'events' ? <span className="nav-badge">{live.events.length}</span> : null}
          </button>
        ))}
        <div style={{ marginTop: 'auto', padding: '10px 8px' }}>
          <div className={`muted mono-sm`}>
            <span className={`dot ${live.connected ? 'ok' : 'err'}`} />
            {live.connected ? 'live stream connected' : 'live stream offline'}
          </div>
          <button
            className="sm"
            style={{ marginTop: 8 }}
            onClick={() => {
              localStorage.removeItem('ukb.token');
              setToken('');
              setTokenDraft('');
            }}
          >
            sign out
          </button>
        </div>
      </nav>

      <main className="main">
        {loginError ? (
          <div className="error-text" style={{ marginBottom: 10 }}>
            {loginError}
          </div>
        ) : null}
        {page === 'dashboard' ? (
          <Dashboard api={api} live={live.events} onOpenLogs={() => setPage('logs')} />
        ) : null}
        {page === 'bots' ? <Bots api={api} /> : null}
        {page === 'automation' ? <Automation api={api} /> : null}
        {page === 'tasks' ? <Tasks api={api} /> : null}
        {page === 'players' ? <Players api={api} /> : null}
        {page === 'deliveries' ? <Deliveries api={api} /> : null}
        {page === 'orders' ? <Orders api={api} /> : null}
        {page === 'waypoints' ? <Waypoints api={api} /> : null}
        {page === 'inventory' ? <Inventory api={api} /> : null}
        {page === 'storage' ? <Storage api={api} /> : null}
        {page === 'chat' ? <Chat api={api} /> : null}
        {page === 'discord' ? <DiscordPage api={api} /> : null}
        {page === 'logs' ? <Logs api={api} /> : null}
        {page === 'events' ? <Events api={api} live={live.events} /> : null}
        {page === 'settings' ? <Settings api={api} /> : null}
      </main>
    </div>
  );
}
