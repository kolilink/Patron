// YYYY-MM-DD from LOCAL components. Never toISOString(): that is UTC, so after
// 8 PM in a negative-offset zone it already reads as tomorrow.
export function localDateISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayIso(): string {
  return localDateISO();
}

export function formatSaleDate(iso: string): string {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// One date system. Every human-readable date goes through formatDate() with a
// named format — no inline toLocaleDateString anywhere else (enforced by
// __tests__/copy-guard.test.ts). Date-only ISO strings ("2026-10-12") are read
// as local midnight so the day never shifts with the device timezone.
export type DateFormat =
  | 'short'           // 12 oct. 2026
  | 'long'            // 12 octobre 2026
  | 'monthYear'       // octobre 2026
  | 'dayMonth'        // 12 oct.
  | 'month'           // octobre
  | 'numeric'         // 12/10/2026
  | 'weekdayLong'     // lundi 12 octobre
  | 'weekdayLongYear'; // lundi 12 octobre 2026

const DATE_FORMATS: Record<DateFormat, Intl.DateTimeFormatOptions | undefined> = {
  short: { day: 'numeric', month: 'short', year: 'numeric' },
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  monthYear: { month: 'long', year: 'numeric' },
  dayMonth: { day: 'numeric', month: 'short' },
  month: { month: 'long' },
  numeric: undefined,
  weekdayLong: { weekday: 'long', day: 'numeric', month: 'long' },
  weekdayLongYear: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
};

export function toDate(input: Date | string | number): Date {
  if (input instanceof Date) return input;
  if (typeof input === 'string' && !input.includes('T')) return new Date(input + 'T00:00:00');
  return new Date(input);
}

export function formatDate(input: Date | string | number, format: DateFormat): string {
  return toDate(input).toLocaleDateString('fr-FR', DATE_FORMATS[format]);
}
