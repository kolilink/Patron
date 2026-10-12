// The one place a queued row_write reaches Supabase (part of the write pipeline; see lib/writeFunnel.ts).
import { ROW_WRITE_TABLES } from '@/lib/rowWritePolicy';

/** Generic display/link write (lib/rowWritePolicy.ts). Idempotent by construction: last-writer-wins updates/upserts, link insert/delete treat "already so" as success. */
export async function executeRowWrite(db: { from: (t: string) => any }, payload: Record<string, unknown>): Promise<void> {
  const table = payload.table as string;
  const values = (payload.values ?? {}) as Record<string, unknown>;
  const match = (payload.match ?? {}) as Record<string, unknown>;
  const policy = ROW_WRITE_TABLES[table];
  if (!policy) throw new Error(`row_write: unknown table ${table}`);
  const t = db.from(table);
  let error: { code?: string; message?: string } | null = null;
  switch (payload.op) {
    case 'insert': ({ error } = await t.insert(values)); if (error?.code === '23505') error = null; break;
    case 'upsert': ({ error } = await t.upsert(values, policy.onConflict ? { onConflict: policy.onConflict } : undefined)); break;
    case 'update': ({ error } = await t.update(values).match(match)); break;
    case 'delete': ({ error } = await t.delete().match(match)); break;
    default: throw new Error(`row_write: unknown op ${String(payload.op)}`);
  }
  if (error) {
    // A table write has no RAISE EXCEPTION, so a refusal arrives as a raw SQLSTATE. Permission / constraint / malformed-value
    // refusals can never succeed on retry (and would wedge the FIFO) → surface them as a business rejection (P0001).
    if (error.code && ['42501', '23502', '23503', '23514', '22P02'].includes(error.code)) {
      throw Object.assign(new Error(error.message ?? 'Écriture refusée'), { code: 'P0001' });
    }
    throw error;
  }
}

