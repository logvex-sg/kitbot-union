import type { AgentEvent } from '@unionkitbot/shared';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, Table, fmtTime, str } from '../ui';

export function Events({ api, live }: { api: Api; live: AgentEvent[] }) {
  const events = usePoll(() => api.events({}), 8000);
  const system = (events.data?.events ?? []) as Array<Record<string, unknown>>;
  const deaths = (events.data?.deaths ?? []) as Array<Record<string, unknown>>;
  const tpa = (events.data?.tpa ?? []) as Array<Record<string, unknown>>;
  const sessions = usePoll(() => api.sessions(), 15000);
  const sessionList = (sessions.data?.sessions ?? []) as Array<Record<string, unknown>>;

  return (
    <>
      <div className="page-head">
        <h1>Events</h1>
        <span className="sub">
          {live.length} live · {system.length} stored
        </span>
      </div>

      <div className="grid">
        <Card title="Live stream" className="span-2">
          {live.length === 0 ? (
            <Empty>no live events</Empty>
          ) : (
            <div className="log">
              {live
                .slice(-20)
                .reverse()
                .map((event, index) => (
                  <div key={`${event.id}-${index}`} className={`log-line sev-${event.severity}`}>
                    <span className="log-time">{fmtTime(event.at)}</span>
                    <span className="log-type">{event.type}</span>
                    <span className="log-msg">{event.message}</span>
                  </div>
                ))}
            </div>
          )}
        </Card>

        <Card title="Death events">
          {deaths.length === 0 ? (
            <Empty>no deaths</Empty>
          ) : (
            deaths
              .slice(0, 8)
              .map((death) => (
                <Row
                  key={String(death.id)}
                  k={fmtTime(death.createdAt)}
                  v={`${str(death.dimension)} @ ${str(death.x)}, ${str(death.y)}, ${str(death.z)}`}
                />
              ))
          )}
        </Card>

        <Card title="TPA events">
          {tpa.length === 0 ? (
            <Empty>no TPA events</Empty>
          ) : (
            tpa
              .slice(0, 8)
              .map((row) => (
                <Row
                  key={String(row.id)}
                  k={str(row.player)}
                  v={row.accepted ? 'accepted' : 'rejected'}
                />
              ))
          )}
        </Card>
      </div>

      <Card title="Bot sessions" className="span-full">
        {sessionList.length === 0 ? (
          <Empty>no sessions recorded</Empty>
        ) : (
          <Table head={['state', 'server', 'reconnects', 'started', 'ended', 'reason']}>
            {sessionList.map((session) => (
              <tr key={String(session.id)}>
                <td>{str(session.state)}</td>
                <td className="muted">{str(session.serverHost)}</td>
                <td>{str(session.reconnectCount, '0')}</td>
                <td className="muted">{fmtTime(session.startedAt)}</td>
                <td className="muted">{fmtTime(session.endedAt)}</td>
                <td className="muted">{str(session.endReason)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
