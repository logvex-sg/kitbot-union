import { useEffect, useState } from 'react';
import { Api } from '../api';
import { Card, Row, str } from '../ui';

const ACCENTS = ['#5aa469', '#4f8ef7', '#c86bfa', '#e0b341', '#e06c75', '#3fbfb0'];

export function Settings({ api }: { api: Api }) {
  const [accent, setAccent] = useState(localStorage.getItem('ukb.accent') ?? '#5aa469');
  const [apiBase, setApiBase] = useState(
    localStorage.getItem('ukb.apiBase') ?? window.location.origin,
  );
  const [token, setToken] = useState(localStorage.getItem('ukb.token') ?? '');
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);

  const save = () => {
    localStorage.setItem('ukb.accent', accent);
    localStorage.setItem('ukb.apiBase', apiBase);
    localStorage.setItem('ukb.token', token);
    setStatus('saved. reload to apply the API base or token change.');
  };

  const test = async () => {
    try {
      const result = await api.health();
      setHealth(result);
      setStatus('api reachable');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'health check failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <span className="sub">local UI preferences and connectivity</span>
      </div>
      {status ? (
        <div className="toolbar">
          <span className="muted mono-sm">{status}</span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Appearance" className="span-2">
          <label>accent colour</label>
          <div className="inline" style={{ marginBottom: 10 }}>
            {ACCENTS.map((color) => (
              <button
                key={color}
                className="sm"
                style={{ background: color, borderColor: color, width: 34, height: 26 }}
                onClick={() => setAccent(color)}
                title={color}
              />
            ))}
            <input
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              style={{ width: 120 }}
            />
          </div>
          <Row k="preview" v={<span style={{ color: accent }}>accent preview</span>} />
        </Card>

        <Card title="API connection">
          <div className="field">
            <label>api base url</label>
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
          </div>
          <div className="field">
            <label>api token</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div className="row-actions">
            <button className="primary" onClick={save}>
              save
            </button>
            <button onClick={test}>test connection</button>
          </div>
          <div className="muted mono-sm" style={{ marginTop: 8 }}>
            Credentials are stored in this browser only and sent as the x-api-key header.
          </div>
        </Card>

        <Card title="Health">
          {!health ? (
            <div className="muted mono-sm">run a connection test</div>
          ) : (
            <>
              <Row k="status" v={str(health.status)} />
              <Row k="database" v={str(health.database)} />
              <Row k="redis" v={str(health.redis)} />
              <Row k="agent" v={str(health.agent)} />
              <Row k="ws clients" v={str(health.wsClients)} />
            </>
          )}
        </Card>
      </div>
    </>
  );
}
