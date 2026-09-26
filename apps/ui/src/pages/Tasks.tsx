import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Pill, Table, fmtTime, str } from '../ui';

const TYPES = [
  'DELIVERY',
  'NAVIGATE',
  'FOLLOW',
  'STORAGE_SCAN',
  'INVENTORY',
  'RECONNECT',
  'STATISTICS',
];
const PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

export function Tasks({ api }: { api: Api }) {
  const bots = usePoll(() => api.bots(), 15000);
  const tasks = usePoll(() => api.tasks(), 5000);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: 'DELIVERY',
    priority: 'NORMAL',
    recipient: '',
    kitIds: 'starter',
    x: '0',
    y: '64',
    z: '0',
    player: '',
  });

  const bot = ((bots.data?.bots ?? []) as Array<Record<string, unknown>>)[0];
  const list = (tasks.data?.tasks ?? []) as Array<Record<string, unknown>>;

  const payloadFor = (): unknown => {
    switch (form.type) {
      case 'DELIVERY':
        return {
          recipient: form.recipient,
          kitIds: form.kitIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        };
      case 'NAVIGATE':
        return { target: { x: Number(form.x), y: Number(form.y), z: Number(form.z) } };
      case 'FOLLOW':
        return { player: form.player };
      case 'STORAGE_SCAN':
        return { origin: { x: Number(form.x), y: Number(form.y), z: Number(form.z) } };
      default:
        return {};
    }
  };

  const create = async () => {
    if (!bot) {
      setMessage('register a bot first');
      return;
    }
    try {
      const result = await api.createTask({
        botId: bot.id,
        type: form.type,
        priority: form.priority,
        payload: payloadFor(),
      });
      setMessage(`queued: ${str(result.message, 'ok')}`);
      await tasks.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'create failed');
    }
  };

  const act = async (id: string, action: 'cancel' | 'pause' | 'resume') => {
    try {
      if (action === 'cancel') await api.cancelTask(id);
      else if (action === 'pause') await api.pauseTask(id);
      else await api.resumeTask(id);
      setMessage(`${action} requested`);
      await tasks.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'action failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Tasks</h1>
        <span className="sub">{list.length} tracked</span>
      </div>
      {message ? (
        <div className="toolbar">
          <span className="muted mono-sm">{message}</span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Create task" className="span-2">
          <div className="form-row">
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
              <label>priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            {form.type === 'DELIVERY' ? (
              <>
                <div className="field">
                  <label>recipient</label>
                  <input
                    value={form.recipient}
                    onChange={(e) => setForm({ ...form, recipient: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>kit ids</label>
                  <input
                    value={form.kitIds}
                    onChange={(e) => setForm({ ...form, kitIds: e.target.value })}
                  />
                </div>
              </>
            ) : null}
            {form.type === 'FOLLOW' ? (
              <div className="field">
                <label>player</label>
                <input
                  value={form.player}
                  onChange={(e) => setForm({ ...form, player: e.target.value })}
                />
              </div>
            ) : null}
            {form.type === 'NAVIGATE' || form.type === 'STORAGE_SCAN' ? (
              <>
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
              </>
            ) : null}
          </div>
          <button className="primary" onClick={create}>
            enqueue task
          </button>
        </Card>
      </div>

      <Card title="Queue" className="span-full">
        {list.length === 0 ? (
          <Empty>no tasks</Empty>
        ) : (
          <Table head={['priority', 'type', 'status', 'attempts', 'created', 'actions']}>
            {list.map((task) => (
              <tr key={String(task.id)}>
                <td>
                  <Pill label={str(task.priority)} kind={str(task.priority)} />
                </td>
                <td>{str(task.type)}</td>
                <td>{str(task.status)}</td>
                <td>{str(task.attempts, '0')}</td>
                <td className="muted">{fmtTime(task.createdAt)}</td>
                <td>
                  <div className="row-actions">
                    <button className="sm" onClick={() => act(String(task.id), 'pause')}>
                      pause
                    </button>
                    <button className="sm" onClick={() => act(String(task.id), 'resume')}>
                      resume
                    </button>
                    <button className="sm danger" onClick={() => act(String(task.id), 'cancel')}>
                      cancel
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
