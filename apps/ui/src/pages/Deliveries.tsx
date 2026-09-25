import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Table, fmtDuration, fmtTime, num, str } from '../ui';

export function Deliveries({ api }: { api: Api }) {
  const deliveries = usePoll(() => api.deliveries(), 5000);
  const kits = usePoll(() => api.kits(), 30000);
  const bots = usePoll(() => api.bots(), 30000);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ recipient: '', kits: 'starter' });

  const list = (deliveries.data?.deliveries ?? []) as Array<Record<string, unknown>>;
  const kitList = (kits.data?.kits ?? []) as Array<Record<string, unknown>>;
  const bot = ((bots.data?.bots ?? []) as Array<Record<string, unknown>>)[0];

  const queue = async () => {
    if (!bot || !form.recipient) {
      setMessage('select a bot and recipient');
      return;
    }
    try {
      const result = await api.botCommand(String(bot.id), 'deliver', [
        form.recipient,
        ...form.kits
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ]);
      setMessage(`queued: ${str(result.message, 'ok')}`);
      await deliveries.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'queue failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Deliveries</h1>
        <span className="sub">
          {list.length} records · {kitList.length} kits
        </span>
      </div>
      {message ? (
        <div className="toolbar">
          <span className="muted mono-sm">{message}</span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Queue delivery" className="span-2">
          <div className="form-row">
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
                value={form.kits}
                onChange={(e) => setForm({ ...form, kits: e.target.value })}
              />
            </div>
          </div>
          <button className="primary" onClick={queue} disabled={!bot}>
            queue delivery
          </button>
          {!bot ? (
            <div className="muted mono-sm" style={{ marginTop: 6 }}>
              register a bot first
            </div>
          ) : null}
        </Card>
      </div>

      <Card title="History" className="span-full">
        {list.length === 0 ? (
          <Empty>no deliveries yet</Empty>
        ) : (
          <Table head={['status', 'recipient', 'kits', 'verified', 'step', 'created', 'completed']}>
            {list.map((d) => (
              <tr key={String(d.id)}>
                <td>{str(d.status)}</td>
                <td>{str(d.recipient)}</td>
                <td className="muted mono-sm">
                  {Array.isArray(d.kitIds) ? (d.kitIds as string[]).join(', ') : str(d.kitIds)}
                </td>
                <td>{d.verified ? 'yes' : 'no'}</td>
                <td className="muted">{str(d.currentStep)}</td>
                <td className="muted">{fmtTime(d.createdAt)}</td>
                <td className="muted">{fmtTime(d.completedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid" style={{ marginTop: 12 }}>
        <Card title="Kits (CRUD)" className="span-2">
          <KitEditor api={api} kits={kitList} onChanged={() => kits.refresh()} />
        </Card>
        <Card title="Throughput">
          <div className="muted mono-sm">
            completed: {list.filter((d) => d.status === 'COMPLETED').length}
          </div>
          <div className="muted mono-sm">
            failed: {list.filter((d) => d.status === 'FAILED').length}
          </div>
          <div className="muted mono-sm">
            in progress: {list.filter((d) => d.status === 'IN_PROGRESS').length}
          </div>
          <div className="muted mono-sm" style={{ marginTop: 8 }}>
            avg verify:{' '}
            {num((list.filter((d) => d.verified).length / Math.max(list.length, 1)) * 100, 0)}%
            verified
          </div>
          <div className="muted mono-sm">
            last update: {fmtTime(new Date().toISOString())} · {fmtDuration(0)}
          </div>
        </Card>
      </div>
    </>
  );
}

function KitEditor({
  api,
  kits,
  onChanged,
}: {
  api: Api;
  kits: Array<Record<string, unknown>>;
  onChanged: () => Promise<void>;
}) {
  const [id, setId] = useState('starter');
  const [items, setItems] = useState('minecraft:bread:32\nminecraft:iron_pickaxe:1');
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    try {
      const parsed = items
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [item, count] =
            line.split(':').length > 2
              ? [line.slice(0, line.lastIndexOf(':')), line.slice(line.lastIndexOf(':') + 1)]
              : line.split(':');
          return { item, count: Number(count) };
        });
      await api.putKit(id, { id, name: id, items: parsed });
      setMessage(`saved kit ${id}`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'save failed');
    }
  };

  const remove = async (kitId: string) => {
    try {
      await api.deleteKit(kitId);
      setMessage(`deleted ${kitId}`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'delete failed');
    }
  };

  return (
    <>
      {message ? (
        <div className="muted mono-sm" style={{ marginBottom: 8 }}>
          {message}
        </div>
      ) : null}
      <div className="form-row">
        <div className="field">
          <label>kit id</label>
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>items (one per line, item:count)</label>
        <textarea rows={5} value={items} onChange={(e) => setItems(e.target.value)} />
      </div>
      <button className="primary" onClick={save}>
        save kit
      </button>

      <div style={{ marginTop: 12 }}>
        {kits.length === 0 ? (
          <Empty>no kits defined</Empty>
        ) : (
          <Table head={['kit id', 'items', 'actions']}>
            {kits.map((kit) => (
              <tr key={String(kit.id)}>
                <td>{str(kit.id)}</td>
                <td className="muted mono-sm">
                  {Array.isArray(kit.items)
                    ? (kit.items as Array<{ item: string; count: number }>)
                        .map((i) => `${i.count}x ${i.item}`)
                        .join(', ')
                    : '-'}
                </td>
                <td>
                  <button className="sm danger" onClick={() => remove(String(kit.id))}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </>
  );
}
