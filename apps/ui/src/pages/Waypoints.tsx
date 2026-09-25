import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Table, fmtTime, num, str } from '../ui';

const TYPES = ['DELIVERY', 'DEATH', 'STORAGE', 'TARGET', 'BASE', 'CUSTOM'];

export function Waypoints({ api }: { api: Api }) {
  const [filter, setFilter] = useState<{ type: string; search: string }>({ type: '', search: '' });
  const waypoints = usePoll(
    () =>
      api.waypoints({
        ...(filter.type ? { type: filter.type } : {}),
        ...(filter.search ? { search: filter.search } : {}),
      }),
    10000,
    [filter.type, filter.search],
  );
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    type: 'CUSTOM',
    dimension: 'overworld',
    x: '0',
    y: '64',
    z: '0',
  });

  const list = (waypoints.data?.waypoints ?? []) as Array<Record<string, unknown>>;

  const create = async () => {
    try {
      await api.createWaypoint({
        name: form.name || 'waypoint',
        type: form.type,
        server: 'manual',
        dimension: form.dimension,
        x: Number(form.x),
        y: Number(form.y),
        z: Number(form.z),
        metadata: {},
      });
      setMessage('waypoint created');
      await waypoints.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'create failed');
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteWaypoint(id);
      setMessage('deleted');
      await waypoints.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'delete failed');
    }
  };

  const navigate = async (id: string) => {
    const waypoint = list.find((w) => String(w.id) === id);
    if (!waypoint) return;
    try {
      const result = await api.botCommand('', 'goto', [
        str(waypoint.x),
        str(waypoint.y),
        str(waypoint.z),
      ]);
      setMessage(`goto: ${str(result.message, 'queued')}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'goto failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Waypoints</h1>
        <span className="sub">{list.length} entries</span>
      </div>
      {message ? (
        <div className="toolbar">
          <span className="muted mono-sm">{message}</span>
        </div>
      ) : null}

      <div className="toolbar">
        <select
          value={filter.type}
          onChange={(e) => setFilter({ ...filter, type: e.target.value })}
          style={{ width: 'auto' }}
        >
          <option value="">all types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          placeholder="search name"
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          style={{ width: 200 }}
        />
      </div>

      <div className="grid">
        <Card title="Create waypoint" className="span-2">
          <div className="form-row">
            <div className="field">
              <label>name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>type</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>dimension</label>
              <input
                value={form.dimension}
                onChange={(e) => setForm({ ...form, dimension: e.target.value })}
              />
            </div>
            <div className="field">
              <label>x</label>
              <input value={form.x} onChange={(e) => setForm({ ...form, x: e.target.value })} />
            </div>
            <div className="field">
              <label>y</label>
              <input value={form.y} onChange={(e) => setForm({ ...form, y: e.target.value })} />
            </div>
            <div className="field">
              <label>z</label>
              <input value={form.z} onChange={(e) => setForm({ ...form, z: e.target.value })} />
            </div>
          </div>
          <button className="primary" onClick={create}>
            create waypoint
          </button>
        </Card>
      </div>

      <Card title="Waypoints" className="span-full">
        {list.length === 0 ? (
          <Empty>no waypoints</Empty>
        ) : (
          <Table head={['name', 'type', 'dimension', 'position', 'bot', 'created', 'actions']}>
            {list.map((w) => (
              <tr key={String(w.id)}>
                <td>{str(w.name)}</td>
                <td>{str(w.type)}</td>
                <td className="muted">{str(w.dimension)}</td>
                <td className="muted mono-sm">{`${num(w.x)}, ${num(w.y)}, ${num(w.z)}`}</td>
                <td className="muted">{str(w.botId)}</td>
                <td className="muted">{fmtTime(w.createdAt)}</td>
                <td>
                  <div className="row-actions">
                    <button className="sm" onClick={() => navigate(String(w.id))}>
                      goto
                    </button>
                    <button className="sm danger" onClick={() => remove(String(w.id))}>
                      delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
