import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { supabase } from '@/lib/supabase';

// Shared by boutique chat (incl. partner DM rooms) and support chat — same
// bucket, same compress-then-upload shape, so neither store re-derives it.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.7;

export async function uploadMessageImage(params: {
  fileUri: string;
  sourceWidth?: number;
  sourceHeight?: number;
  storagePath: string; // e.g. `chat/${roomId}/${messageId}.jpg`
}): Promise<{ url: string; width: number; height: number }> {
  const { fileUri, sourceWidth, sourceHeight, storagePath } = params;

  // Resize only if larger than MAX_DIMENSION on the longest edge — never
  // upscale a small image. West-Africa-low-bandwidth is the whole reason
  // this app exists; a raw 4-8MB photo upload is not acceptable.
  let context = ImageManipulator.manipulate(fileUri);
  const longestEdge = Math.max(sourceWidth ?? 0, sourceHeight ?? 0);
  if (longestEdge > MAX_DIMENSION) {
    context = (sourceWidth ?? 0) >= (sourceHeight ?? 0)
      ? context.resize({ width: MAX_DIMENSION })
      : context.resize({ height: MAX_DIMENSION });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });

  // fetch().blob() produces 0-byte blobs for file:// URIs in Hermes — same
  // issue documented for voice uploads in stores/chat.ts. Read via
  // FileSystem as base64 and decode to Uint8Array instead.
  const base64 = await FileSystem.readAsStringAsync(saved.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const { error: uploadErr } = await supabase.storage
    .from('message-images')
    .upload(storagePath, bytes, { contentType: 'image/jpeg', upsert: false });
  if (uploadErr) throw uploadErr;

  // Public bucket — permanent URL, no expiry, no tokens (same posture as
  // voice-messages; access is gated at the message-row level by RLS).
  const { data: urlData } = supabase.storage.from('message-images').getPublicUrl(storagePath);

  return { url: urlData.publicUrl, width: saved.width, height: saved.height };
}
