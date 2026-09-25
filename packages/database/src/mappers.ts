export type Row = Record<string, unknown>;

export function jsonb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

export function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
