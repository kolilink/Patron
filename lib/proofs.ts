import { uploadMessageImage } from '@/lib/chatImages';
import { supabase } from '@/lib/supabase';

// Photo proof for money-movement records (apports, expenses, purchase
// orders). One optional image per row, attached after the row already
// exists — see db/migration_v155.sql. The upload path and the
// attach_transaction_proof RPC are the single shared entry point for all
// three surfaces; each screen just supplies its own kind + row id.
export type ProofKind = 'apport' | 'expense' | 'purchase_order';

export async function attachTransactionProof(params: {
  kind: ProofKind;
  id: string;
  businessId: string;
  fileUri: string;
  sourceWidth?: number;
  sourceHeight?: number;
}): Promise<{ url: string; width: number; height: number }> {
  const { kind, id, businessId, fileUri, sourceWidth, sourceHeight } = params;

  // upsert:true — the storage path is deterministic per transaction id, so
  // if a previous attempt uploaded the file but the RPC then failed, a retry
  // must be able to overwrite it. DB-level immutability (the RPC refuses when
  // a proof is already set) is the real add-once guard, not the storage layer.
  const { url, width, height } = await uploadMessageImage({
    fileUri,
    sourceWidth,
    sourceHeight,
    storagePath: `${kind}/${businessId}/${id}.jpg`,
    bucket: 'transaction-proofs',
    upsert: true,
  });

  const { error } = await supabase.rpc('attach_transaction_proof', {
    p_kind: kind,
    p_id: id,
    p_image_url: url,
    p_image_width: width,
    p_image_height: height,
  });
  if (error) throw error;

  return { url, width, height };
}

// Only the person who attached the proof can remove it, and only within 24h
// of attaching (both enforced server-side against auth.uid()/now() — see
// db/migration_v168.sql). Does not remove the file from Storage, only the
// DB reference to it — see that migration's comment for why.
export async function deleteTransactionProof(params: {
  kind: ProofKind;
  id: string;
}): Promise<void> {
  const { error } = await supabase.rpc('delete_transaction_proof', {
    p_kind: params.kind,
    p_id: params.id,
  });
  if (error) throw error;
}
