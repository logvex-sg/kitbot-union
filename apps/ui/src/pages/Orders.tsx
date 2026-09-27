import { useState } from 'react';
import { Api } from '../api';
import { useApi, usePoll } from '../hooks';
import { Card, Empty, Pill, Row, Table, fmtTime, num, str } from '../ui';

const ACTIVE_STATES = new Set([
  'ORDER_RECEIVED',
  'VALIDATING',
  'RESERVING_ITEMS',
  'NAVIGATING_TO_TPA_POINT',
  'REQUESTING_TPA',
  'WAITING_FOR_TPA',
  'TELEPORT_WAIT',
  'LOCATING_PLAYER',
  'DELIVERING',
  'VERIFYING_DELIVERY',
  'RETURNING_TO_PACK_AREA',
]);

function statusKind(status: string): string {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'FAILED') return 'err';
  if (status === 'CANCELLED') return 'off';
  return 'warn';
}

/** Order history and the manual "queue an order" form. */
export function Orders({ api }: { api: Api }) {
  const orderList = usePoll(() => api.orders({ limit: '50' }), 5000);
  const { run, error } = useApi(api);
  const [player, setPlayer] = useState('');
  const [kits, setKits] = useState('');
  const [busy, setBusy] = useState(false);

  const orders = (orderList.data?.orders ?? []) as Array<Record<string, unknown>>;
  const active = orders.filter((order) => ACTIVE_STATES.has(str(order.state, '')));

  const submit = async (): Promise<void> => {
    const kitIds = kits
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!player.trim()) return;
    setBusy(true);
    const result = await run((client) =>
      client.createOrder({ recipient: player.trim(), kitIds, requestedBy: 'ui' }),
    );
    setBusy(false);
    if (result) {
      setPlayer('');
      setKits('');
      void orderList.refresh();
    }
  };

  const cancel = async (code: number | string): Promise<void> => {
    await run((client) => client.cancelOrder(String(code)));
    void orderList.refresh();
  };

  return (
    <>
      <div className="page-head">
        <h1>Orders</h1>
        <span className="sub">
          {active.length} active · {orders.length} recent
        </span>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="grid">
        <Card title="Queue an order">
          <div className="form-row">
            <label htmlFor="order-player">recipient</label>
            <input
              id="order-player"
              value={player}
              onChange={(event) => setPlayer(event.target.value)}
              placeholder="Minecraft username"
            />
          </div>
          <div className="form-row">
            <label htmlFor="order-kits">kits</label>
            <input
              id="order-kits"
              value={kits}
              onChange={(event) => setKits(event.target.value)}
              placeholder="pvp, starter"
            />
          </div>
          <button type="button" disabled={busy || player.trim().length === 0} onClick={submit}>
            {busy ? 'queueing…' : 'queue order'}
          </button>
        </Card>

        <Card title="Active orders">
          {active.length === 0 ? (
            <Empty>no active orders</Empty>
          ) : (
            active.map((order) => (
              <Row
                key={String(order.id)}
                k={`#${num(order.code)} ${str(order.recipient)}`}
                v={<Pill label={str(order.state)} kind="warn" />}
              />
            ))
          )}
        </Card>
      </div>

      <Card title="Order history" className="span-full">
        {orders.length === 0 ? (
          <Empty>no orders recorded yet</Empty>
        ) : (
          <Table head={['code', 'recipient', 'kits', 'state', 'status', 'created', '']}>
            {orders.map((order) => {
              const status = str(order.status);
              return (
                <tr key={String(order.id)}>
                  <td className="mono-sm">#{num(order.code)}</td>
                  <td>{str(order.recipient)}</td>
                  <td className="muted">{str(order.kitIds)}</td>
                  <td className="muted">{str(order.state)}</td>
                  <td>
                    <Pill label={status} kind={statusKind(status)} />
                  </td>
                  <td className="muted">{fmtTime(order.createdAt)}</td>
                  <td>
                    {ACTIVE_STATES.has(str(order.state, '')) ? (
                      <button type="button" onClick={() => void cancel(num(order.code))}>
                        cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
