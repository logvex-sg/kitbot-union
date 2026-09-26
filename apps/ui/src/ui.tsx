import type { ReactNode } from 'react';

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title ? <div className="card-title">{title}</div> : null}
      {children}
    </section>
  );
}

export function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="card-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function StatusDot({ state }: { state: string | null | undefined }) {
  const s = (state ?? '').toUpperCase();
  const cls =
    s === 'IDLE' || s === 'CONNECTING' || s === 'SPAWNING'
      ? 'ok'
      : s === 'NAVIGATING' || s === 'DELIVERING' || s === 'SCANNING' || s === 'RECOVERING'
        ? 'warn'
        : s === 'DEAD' || s === 'ERROR'
          ? 'err'
          : 'off';
  return <span className={`dot ${cls}`} title={s || 'UNKNOWN'} />;
}

export function Pill({ label, kind }: { label: string; kind?: string }) {
  return <span className={`pill ${kind ?? ''}`}>{label}</span>;
}

export function Empty({ children = 'no data' }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function fmtTime(value: unknown): string {
  if (!value) return '-';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString();
}

export function fmtDuration(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const s = Math.floor(n / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function num(value: unknown, digits = 0): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toFixed(digits);
}

export function str(value: unknown, fallback = '-'): string {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

export function pos(value: unknown): string {
  if (!value || typeof value !== 'object') return '-';
  const p = value as { x?: number; y?: number; z?: number };
  if (p.x === undefined || p.y === undefined || p.z === undefined) return '-';
  return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
}
