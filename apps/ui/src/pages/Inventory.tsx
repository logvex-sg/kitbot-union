import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, StatusDot, Table, num, str } from '../ui';

export function Inventory({ api }: { api: Api }) {
  const bots = usePoll(() => api.bots(), 5000);
  const list = (bots.data?.bots ?? []) as Array<Record<string, unknown>>;
  const bot = list[0];
  const live = (bot?.live ?? {}) as Record<string, unknown>;
  const inventory = live.inventory as {
    items?: Array<{ name: string; count: number }>;
    usedSlots?: number;
    totalSlots?: number;
  } | null;

  return (
    <>
      <div className="page-head">
        <h1>Inventory</h1>
        <span className="sub">{bot ? `${str(bot.name)} · ${str(bot.username)}` : 'no bot'}</span>
      </div>

      <div className="grid">
        <Card title="Capacity">
          <div className="card-value">
            {num(inventory?.usedSlots)} / {num(inventory?.totalSlots)}
          </div>
          <div className="bar" style={{ marginTop: 8 }}>
            <span
              style={{
                width: `${Math.min(100, ((inventory?.usedSlots ?? 0) / Math.max(inventory?.totalSlots ?? 36, 1)) * 100)}%`,
              }}
            />
          </div>
        </Card>
        <Card title="Bot">
          <Row
            k="state"
            v={
              <>
                <StatusDot state={str(live.state, 'OFFLINE')} />
                {str(live.state, 'OFFLINE')}
              </>
            }
          />
          <Row k="dimension" v={str(live.dimension)} />
          <Row k="health" v={num(live.health, 1)} />
          <Row k="hunger" v={num(live.food, 1)} />
        </Card>
        <Card title="Controls">
          <div className="row-actions">
            <button
              className="sm"
              disabled={!bot}
              onClick={() => bot && api.botCommand(String(bot.id), 'inventory')}
            >
              refresh
            </button>
          </div>
          <div className="muted mono-sm" style={{ marginTop: 8 }}>
            Inventory is read directly from the live mineflayer client state.
          </div>
        </Card>
      </div>

      <Card title="Items" className="span-full">
        {!inventory || (inventory.items ?? []).length === 0 ? (
          <Empty>{bot ? 'inventory is empty or bot is offline' : 'register a bot first'}</Empty>
        ) : (
          <Table head={['item', 'count']}>
            {(inventory.items ?? []).map((item) => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td>{item.count}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
