import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Table, fmtTime, str } from '../ui';

export function Players({ api }: { api: Api }) {
  const players = usePoll(() => api.players(), 15000);
  const list = (players.data?.players ?? []) as Array<Record<string, unknown>>;

  return (
    <>
      <div className="page-head">
        <h1>Players</h1>
        <span className="sub">{list.length} known</span>
      </div>
      <div className="grid">
        <Card title="Known players" className="span-2">
          {list.length === 0 ? (
            <Empty>no players recorded yet</Empty>
          ) : (
            <Table head={['username', 'uuid', 'first seen', 'last seen']}>
              {list.map((player) => (
                <tr key={String(player.id)}>
                  <td>{str(player.username)}</td>
                  <td className="muted mono-sm">{str(player.minecraftUuid)}</td>
                  <td className="muted">{fmtTime(player.firstSeenAt)}</td>
                  <td className="muted">{fmtTime(player.lastSeenAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Online right now">
          <div className="muted mono-sm">
            Live presence is reported by the bot on the Dashboard.
          </div>
          <Empty>use the Automation page quick action to list players on demand</Empty>
        </Card>
      </div>
    </>
  );
}
