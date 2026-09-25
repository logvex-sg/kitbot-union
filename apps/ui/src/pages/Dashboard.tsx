import { useEffect } from 'react';
import type { AgentEvent } from '@unionkitbot/shared';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, StatusDot, fmtDuration, fmtTime, num, pos, str } from '../ui';

export function Dashboard({
  api,
  live,
  onOpenLogs,
}: {
  api: Api;
  live: AgentEvent[];
  onOpenLogs: () => void;
}) {
  const health = usePoll(() => api.health(), 5000);
  const bots = usePoll(() => api.bots(), 5000);
  const tasks = usePoll(() => api.tasks(), 8000);
  const deliveries = usePoll(() => api.deliveries(), 15000);
  const discord = usePoll(() => api.discord(), 60000);

  useEffect(() => {
    const accent = localStorage.getItem('ukb.accent');
    if (accent) document.documentElement.style.setProperty('--accent', accent);
  }, []);

  const botList = (bots.data?.bots ?? []) as Array<Record<string, unknown>>;
  const primary = botList[0];
  const liveState = (primary?.live ?? {}) as Record<string, unknown>;
  const openTasks = ((tasks.data?.tasks ?? []) as Array<Record<string, unknown>>).filter(
    (t) => t.status === 'PENDING' || t.status === 'RUNNING' || t.status === 'PAUSED',
  );
  const running = ((deliveries.data?.deliveries ?? []) as Array<Record<string, unknown>>).filter(
    (d) => d.status === 'IN_PROGRESS',
  );
  const proc = (health.data?.process ?? {}) as Record<string, unknown>;

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <span className="sub">
          {health.data ? `api ${str(health.data.status)}` : 'loading'} · ws {live.length} events
          buffered
        </span>
      </div>

      <div className="grid tight">
        <Card title="Bot state">
          <div className="card-value">
            <StatusDot state={str(liveState.state, str(primary?.live ? 'UNKNOWN' : 'OFFLINE'))} />
            {str(liveState.state, botList.length === 0 ? 'NO BOT' : 'OFFLINE')}
          </div>
          <Row k="connected" v={liveState.connected ? 'yes' : 'no'} />
          <Row k="uptime" v={fmtDuration(liveState.uptimeMs)} />
          <Row k="reconnects" v={num(liveState.reconnectCount)} />
        </Card>

        <Card title="Server / position">
          <Row k="server" v={str(liveState.server, str(primary?.serverHost))} />
          <Row k="dimension" v={str(liveState.dimension)} />
          <Row k="position" v={pos(liveState.position)} />
        </Card>

        <Card title="Vitals">
          <Row k="health" v={num(liveState.health, 1)} />
          <div className="bar" style={{ marginBottom: 8 }}>
            <span
              className="hp"
              style={{ width: `${Math.min(100, Number(liveState.health ?? 0) * 5)}%` }}
            />
          </div>
          <Row k="hunger" v={num(liveState.food, 1)} />
          <div className="bar">
            <span
              className="food"
              style={{ width: `${Math.min(100, Number(liveState.food ?? 0) * 5)}%` }}
            />
          </div>
        </Card>

        <Card title="Current task">
          <div className="card-value">{str(liveState.currentTaskType, 'none')}</div>
          <Row k="target" v={str(liveState.target, 'none')} />
          <Row k="pathfinding" v={str(liveState.pathfinding, 'idle')} />
          <Row k="pending" v={openTasks.length} />
        </Card>

        <Card title="Deliveries">
          <div className="card-value">{running.length}</div>
          <Row k="in progress" v={running.length} />
          <Row k="total loaded" v={((deliveries.data?.deliveries ?? []) as unknown[]).length} />
          <Row
            k="last"
            v={
              ((deliveries.data?.deliveries ?? []) as Array<Record<string, unknown>>)[0]
                ? `${str(((deliveries.data?.deliveries ?? []) as Array<Record<string, unknown>>)[0]!.status)} → ${str(((deliveries.data?.deliveries ?? []) as Array<Record<string, unknown>>)[0]!.recipient)}`
                : 'none'
            }
          />
        </Card>

        <Card title="Discord">
          <div className="card-value">
            {discord.data?.configured ? 'configured' : 'not configured'}
          </div>
          <Row k="guild" v={str(discord.data?.guildId)} />
          <Row k="notify channel" v={str(discord.data?.notifyChannelId)} />
          <Row k="commands" v={String(((discord.data?.commands ?? []) as unknown[]).length)} />
        </Card>

        <Card title="Database / Redis">
          <Row
            k="postgres"
            v={
              <>
                <StatusDot state={health.data?.database === 'up' ? 'IDLE' : 'ERROR'} />
                {str(health.data?.database)}
              </>
            }
          />
          <Row
            k="redis"
            v={
              <>
                <StatusDot state={health.data?.redis === 'up' ? 'IDLE' : 'ERROR'} />
                {str(health.data?.redis)}
              </>
            }
          />
          <Row
            k="agent link"
            v={
              <>
                <StatusDot state={health.data?.agent === 'up' ? 'IDLE' : 'ERROR'} />
                {str(health.data?.agent)}
              </>
            }
          />
          <Row k="ws clients" v={num(health.data?.wsClients)} />
        </Card>

        <Card title="Process">
          <Row k="rss" v={`${num(Number(proc.rssBytes) / 1048576, 1)} MiB`} />
          <Row k="heap" v={`${num(Number(proc.heapUsedBytes) / 1048576, 1)} MiB`} />
          <Row k="cpu user" v={`${num(proc.cpuUserMs)} ms`} />
          <Row k="api uptime" v={fmtDuration(health.data?.uptimeMs)} />
        </Card>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <Card title="Recent events" className="span-2">
          <div className="toolbar">
            <button className="sm" onClick={onOpenLogs}>
              open logs
            </button>
          </div>
          {live.length === 0 ? (
            <Empty>waiting for events…</Empty>
          ) : (
            <div className="log">
              {live
                .slice(-14)
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

        <Card title="Bots">
          {botList.length === 0 ? (
            <Empty>no bots configured</Empty>
          ) : (
            botList.map((bot) => {
              const state = ((bot.live ?? {}) as Record<string, unknown>).state;
              return (
                <Row
                  key={String(bot.id)}
                  k={`${str(bot.name)} (${str(bot.username)})`}
                  v={
                    <>
                      <StatusDot state={str(state, 'OFFLINE')} />
                      {str(state, 'OFFLINE')}
                    </>
                  }
                />
              );
            })
          )}
        </Card>
      </div>
    </>
  );
}
