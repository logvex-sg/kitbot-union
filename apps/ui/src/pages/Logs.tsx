import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Table, fmtTime, str } from '../ui';

export function Logs({ api }: { api: Api }) {
  const [severity, setSeverity] = useState('');
  const logs = usePoll(() => api.logs(severity ? { severity } : {}), 5000, [severity]);
  const entries = (logs.data?.logs ?? []) as Array<Record<string, unknown>>;
  const audit = (logs.data?.audit ?? []) as Array<Record<string, unknown>>;

  return (
    <>
      <div className="page-head">
        <h1>Logs</h1>
        <span className="sub">
          {entries.length} system events · {audit.length} audit entries
        </span>
      </div>

      <div className="toolbar">
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="">all severities</option>
          {['info', 'warn', 'error', 'critical'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="sm" onClick={() => void logs.refresh()}>
          refresh
        </button>
      </div>

      <Card title="System events">
        {entries.length === 0 ? (
          <Empty>no system events</Empty>
        ) : (
          <div className="log">
            {entries.map((entry) => (
              <div key={String(entry.id)} className={`log-line sev-${str(entry.severity, 'info')}`}>
                <span className="log-time">{fmtTime(entry.createdAt)}</span>
                <span className="log-type">{str(entry.type)}</span>
                <span className="log-msg">{str(entry.message)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Audit trail" className="span-full">
        {audit.length === 0 ? (
          <Empty>no audit entries</Empty>
        ) : (
          <Table head={['actor', 'action', 'target', 'at']}>
            {audit.map((row) => (
              <tr key={String(row.id)}>
                <td>{str(row.actor)}</td>
                <td>{str(row.action)}</td>
                <td className="muted">{`${str(row.targetType)} ${str(row.targetId)}`}</td>
                <td className="muted">{fmtTime(row.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
