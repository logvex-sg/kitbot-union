import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, Table, fmtTime, str } from '../ui';

const EVENT_TYPES = [
  '',
  'TPA_REQUEST',
  'DELIVERY_REQUEST',
  'GREETING',
  'SERVER_MESSAGE',
  'DEATH',
  'DISCONNECT',
  'UNKNOWN',
];

export function Chat({ api }: { api: Api }) {
  const [eventType, setEventType] = useState('');
  const chat = usePoll(() => api.chat(eventType ? { eventType } : {}), 5000, [eventType]);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const bots = usePoll(() => api.bots(), 20000);
  const bot = ((bots.data?.bots ?? []) as Array<Record<string, unknown>>)[0];

  const rows = (chat.data?.chat ?? []) as Array<Record<string, unknown>>;
  const parsed = ((chat.data?.recent ?? []) as Array<Record<string, unknown>>).filter(
    (e) => e.type === 'bot:chat',
  );

  const send = async () => {
    if (!bot || !message) {
      setStatus('select a bot and type a message');
      return;
    }
    try {
      await api.botCommand(String(bot.id), 'say', [message]);
      setStatus('message sent');
      setMessage('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'send failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Chat</h1>
        <span className="sub">
          {rows.length} recorded · {parsed.length} live
        </span>
      </div>
      {status ? (
        <div className="toolbar">
          <span className="muted mono-sm">{status}</span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Send as bot" className="span-2">
          <div className="form-row">
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>message</label>
              <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>
            <div className="field">
              <label>filter</label>
              <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
                {EVENT_TYPES.map((t) => (
                  <option key={t || 'all'} value={t}>
                    {t || 'all event types'}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button className="primary" onClick={send} disabled={!bot}>
            send
          </button>
        </Card>
        <Card title="Parsed live chat">
          {parsed.length === 0 ? (
            <Empty>no chat events yet</Empty>
          ) : (
            parsed
              .slice(-10)
              .reverse()
              .map((event, index) => {
                const data = (event.data ?? {}) as Record<string, unknown>;
                return (
                  <Row
                    key={`${index}-${String(event.id)}`}
                    k={`${str(data.eventType)} · ${str(data.player)}`}
                    v={str(event.message)}
                  />
                );
              })
          )}
        </Card>
      </div>

      <Card title="Chat history" className="span-full">
        {rows.length === 0 ? (
          <Empty>no chat recorded</Empty>
        ) : (
          <Table head={['event', 'player', 'message', 'at']}>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                <td>{str(row.eventType)}</td>
                <td>{str(row.player)}</td>
                <td className="muted mono-sm">{str(row.message)}</td>
                <td className="muted">{fmtTime(row.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
