import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, Table, fmtTime, num, str } from '../ui';

export function Storage({ api }: { api: Api }) {
  const scans = usePoll(() => api.storageScans(), 10000);
  const list = (scans.data?.scans ?? []) as Array<Record<string, unknown>>;
  const latest = list[0];
  const counts = (latest?.counts ?? {}) as Record<string, number>;

  return (
    <>
      <div className="page-head">
        <h1>Storage</h1>
        <span className="sub">{list.length} scans</span>
      </div>

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
