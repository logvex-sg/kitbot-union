import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, StatusDot, Table, fmtDuration, num, pos, str } from '../ui';

export function Bots({ api }: { api: Api }) {
  const bots = usePoll(() => api.bots(), 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: 'mc-01',
    username: 'UnionKitBot',
    serverHost: 'localhost',
    serverPort: '25565',
    serverVersion: '',
    authType: 'offline',
    autoConnect: true,
  });

  const list = (bots.data?.bots ?? []) as Array<Record<string, unknown>>;

  const act = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusy(id);
    try {
      const result =
        action === 'start'
          ? await api.startBot(id)
          : action === 'stop'
            ? await api.stopBot(id)
            : await api.restartBot(id);
      setMessage(`${action}: ${str(result.message, 'ok')}`);
      await bots.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'action failed');
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    try {
      await api.createBot({
        name: form.name,
        username: form.username,
        serverHost: form.serverHost,
        serverPort: Number(form.serverPort),
        serverVersion: form.serverVersion || undefined,
        authType: form.authType,
        enabled: true,
        autoConnect: form.autoConnect,
        settings: {},
      });
      setMessage(`created ${form.name}`);
      await bots.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'create failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Bots</h1>
        <span className="sub">{list.length} instances</span>
      </div>
      {message ? (
        <div className="toolbar">
          <span className="muted mono-sm">{message}</span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Register bot" className="span-2">
          <div className="form-row">
            <div className="field">
              <label>name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>minecraft username</label>
              <input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
            <div className="field">
              <label>host</label>
              <input
                value={form.serverHost}
                onChange={(e) => setForm({ ...form, serverHost: e.target.value })}
              />
            </div>
            <div className="field">
              <label>port</label>
              <input
                value={form.serverPort}
                onChange={(e) => setForm({ ...form, serverPort: e.target.value })}
              />
            </div>
            <div className="field">
              <label>version (optional)</label>
              <input
                value={form.serverVersion}
                onChange={(e) => setForm({ ...form, serverVersion: e.target.value })}
              />
            </div>
            <div className="field">
              <label>auth</label>
              <select
                value={form.authType}
                onChange={(e) => setForm({ ...form, authType: e.target.value })}
              >
                <option value="offline">offline</option>
                <option value="microsoft">microsoft</option>
              </select>
            </div>
          </div>
          <div className="inline">
            <button className="primary" onClick={create}>
              create bot
            </button>
            <label className="inline" style={{ margin: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={form.autoConnect}
                onChange={(e) => setForm({ ...form, autoConnect: e.target.checked })}
              />
              <span className="muted mono-sm">auto-connect on boot</span>
            </label>
          </div>
        </Card>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        {list.length === 0 ? (
          <Card>
            <Empty>no bots configured yet</Empty>
          </Card>
        ) : (
          list.map((bot) => {
            const live = (bot.live ?? {}) as Record<string, unknown>;
            return (
              <Card key={String(bot.id)} title={`${str(bot.name)} · ${str(bot.username)}`}>
                <div className="card-value">
                  <StatusDot state={str(live.state, 'OFFLINE')} />
                  {str(live.state, 'OFFLINE')}
                </div>
                <Row k="server" v={`${str(bot.serverHost)}:${str(bot.serverPort)}`} />
                <Row k="dimension" v={str(live.dimension)} />
                <Row k="position" v={pos(live.position)} />
                <Row k="health" v={num(live.health, 1)} />
                <Row k="uptime" v={fmtDuration(live.uptimeMs)} />
                <Row k="reconnects" v={num(live.reconnectCount)} />
                <Row k="enabled" v={bot.enabled ? 'yes' : 'no'} />
                <div className="row-actions" style={{ marginTop: 10 }}>
                  <button
                    className="sm primary"
                    disabled={busy === bot.id}
                    onClick={() => act(String(bot.id), 'start')}
                  >
                    start
                  </button>
                  <button
                    className="sm"
                    disabled={busy === bot.id}
                    onClick={() => act(String(bot.id), 'stop')}
                  >
                    stop
                  </button>
                  <button
                    className="sm danger"
                    disabled={busy === bot.id}
                    onClick={() => act(String(bot.id), 'restart')}
                  >
                    restart
                  </button>
                </div>
              </Card>
            );
          })
        )}
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <Card title="Inventory summary (selected bot)" className="span-full">
          {list[0] ? (
            <Table head={['item', 'count']}>
              {(
                ((list[0].live ?? {}) as Record<string, unknown>).inventory as {
                  items?: Array<{ name: string; count: number }>;
                } | null
              )?.items?.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td>{item.count}</td>
                </tr>
              )) ?? (
                <tr>
                  <td colSpan={2} className="muted">
                    inventory unavailable
                  </td>
                </tr>
              )}
            </Table>
          ) : (
            <Empty />
          )}
        </Card>
      </div>
    </>
  );
}
