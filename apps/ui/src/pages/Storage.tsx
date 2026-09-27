import { useState } from 'react';
import { Api } from '../api';
import { useApi, usePoll } from '../hooks';
import { Card, Empty, Pill, Row, Table, fmtTime, num, str } from '../ui';

export function Storage({ api }: { api: Api }) {
  const scans = usePoll(() => api.storageScans(), 10000);
  const mappings = usePoll(() => api.storageMappings({ limit: '100' }), 10000);
  const { run, error } = useApi(api);
  const [overrideGroup, setOverrideGroup] = useState('');
  const [overrideKit, setOverrideKit] = useState('');

  const list = (scans.data?.scans ?? []) as Array<Record<string, unknown>>;
  const latest = list[0];
  const counts = (latest?.counts ?? {}) as Record<string, number>;
  const mappingList = (mappings.data?.mappings ?? []) as Array<Record<string, unknown>>;

  const applyOverride = async (): Promise<void> => {
    if (!overrideGroup.trim()) return;
    const target = mappingList.find((m) => str(m.groupKey, '') === overrideGroup.trim());
    if (!target) return;
    const kitId = overrideKit.trim();
    await run((client) =>
      client.setStorageMapping(String(target.id), {
        kitId: kitId.length > 0 && kitId !== '-' ? kitId : null,
        overrideEnabled: kitId.length > 0 && kitId !== '-',
      }),
    );
    setOverrideKit('');
    void mappings.refresh();
  };

  return (
    <>
      <div className="page-head">
        <h1>Storage</h1>
        <span className="sub">
          {list.length} scans · {mappingList.length} mappings
        </span>
      </div>

      {error ? <div className="error-text">{error}</div> : null}

      <div className="grid">
        <Card title="Latest logical containers">
          <div className="card-value">{num(latest?.logicalContainerCount)}</div>
          <Row k="radius" v={num(latest?.radius)} />
          <Row k="inspected" v={num(latest?.inspected)} />
          <Row k="dimension" v={str(latest?.dimension)} />
        </Card>
        <Card title="Breakdown">
          {Object.keys(counts).length === 0 ? (
            <Empty>no counts recorded</Empty>
          ) : (
            Object.entries(counts).map(([kind, count]) => (
              <Row key={kind} k={kind} v={num(count)} />
            ))
          )}
        </Card>
      </div>

      <Card title="Kit mapping override">
        <div className="form-row">
          <label htmlFor="mapping-group">storage group</label>
          <input
            id="mapping-group"
            value={overrideGroup}
            onChange={(event) => setOverrideGroup(event.target.value)}
            placeholder="group key from the table below"
          />
        </div>
        <div className="form-row">
          <label htmlFor="mapping-kit">kit (or - to clear)</label>
          <input
            id="mapping-kit"
            value={overrideKit}
            onChange={(event) => setOverrideKit(event.target.value)}
            placeholder="pvp"
          />
        </div>
        <button type="button" disabled={overrideGroup.trim().length === 0} onClick={applyOverride}>
          apply override
        </button>
      </Card>

      <Card title="Sign kit mappings" className="span-full">
        {mappingList.length === 0 ? (
          <Empty>no storage mappings recorded yet</Empty>
        ) : (
          <Table
            head={['group', 'block', 'pos', 'detected', 'override', 'effective', 'seen']}
          >
            {mappingList.map((mapping) => (
              <tr key={String(mapping.id)}>
                <td className="mono-sm">{str(mapping.groupKey)}</td>
                <td className="muted">{str(mapping.blockName)}</td>
                <td className="muted mono-sm">
                  {`${num(mapping.x)}, ${num(mapping.y)}, ${num(mapping.z)}`}
                </td>
                <td>{str(mapping.detectedKitId, '-')}</td>
                <td>
                  {mapping.overrideEnabled ? (
                    <Pill label={str(mapping.overrideKitId, '-')} kind="warn" />
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td>{str(mapping.effectiveKitId ?? mapping.detectedKitId, '-')}</td>
                <td className="muted">{fmtTime(mapping.lastSeenAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Scan history" className="span-full">
        {list.length === 0 ? (
          <Empty>no scans recorded yet</Empty>
        ) : (
          <Table
            head={['scan id', 'origin', 'radius', 'containers', 'inspected', 'dimension', 'at']}
          >
            {list.map((scan) => (
              <tr key={String(scan.id)}>
                <td className="muted mono-sm">{str(scan.id)}</td>
                <td className="muted mono-sm">{`${num(scan.x)}, ${num(scan.y)}, ${num(scan.z)}`}</td>
                <td>{num(scan.radius)}</td>
                <td>{num(scan.logicalContainerCount)}</td>
                <td>{num(scan.inspected)}</td>
                <td className="muted">{str(scan.dimension)}</td>
                <td className="muted">{fmtTime(scan.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
