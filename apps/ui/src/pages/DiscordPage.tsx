import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, Table, fmtTime, str } from '../ui';

export function DiscordPage({ api }: { api: Api }) {
  const discord = usePoll(() => api.discord(), 30000);
  const events = usePoll(() => api.events({}), 10000);
  const data = discord.data ?? {};

  const tpa = (events.data?.tpa ?? []) as Array<Record<string, unknown>>;
  const deaths = (events.data?.deaths ?? []) as Array<Record<string, unknown>>;

  return (
    <>
      <div className="page-head">
        <h1>Discord</h1>
        <span className="sub">{data.configured ? 'bot configured' : 'bot token missing'}</span>
      </div>

      <div className="grid">
        <Card title="Integration">
          <Row k="configured" v={data.configured ? 'yes' : 'no'} />
          <Row k="guild" v={str(data.guildId)} />
          <Row k="notify channel" v={str(data.notifyChannelId)} />
          <div className="muted mono-sm" style={{ marginTop: 8 }}>
            The Discord app runs as an official bot application with slash commands. Notifications
            are driven by agent events, including connect, disconnect, death, TPA, delivery and scan
            results.
          </div>
        </Card>
        <Card title="Registered commands">
          {((data.commands ?? []) as string[]).length === 0 ? (
            <Empty>none</Empty>
          ) : (
            <div className="inline">
              {((data.commands ?? []) as string[]).map((command) => (
                <span className="pill" key={command}>
                  /bot {command}
                </span>
              ))}
            </div>
          )}
        </Card>
        <Card title="TPA decisions">
          {tpa.length === 0 ? (
            <Empty>no TPA activity</Empty>
          ) : (
            <Table head={['player', 'decision', 'mode', 'at']}>
              {tpa.slice(0, 10).map((row) => (
                <tr key={String(row.id)}>
                  <td>{str(row.player)}</td>
                  <td>{row.accepted ? 'accepted' : 'rejected'}</td>
                  <td className="muted">{str(row.mode)}</td>
                  <td className="muted">{fmtTime(row.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Recent deaths">
          {deaths.length === 0 ? (
            <Empty>no deaths recorded</Empty>
          ) : (
            deaths
              .slice(0, 6)
              .map((death) => (
                <Row
                  key={String(death.id)}
                  k={fmtTime(death.createdAt)}
                  v={`${str(death.dimension)} @ ${str(death.x)}, ${str(death.y)}, ${str(death.z)}`}
                />
              ))
          )}
        </Card>
      </div>
    </>
  );
}
