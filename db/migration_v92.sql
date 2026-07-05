-- v92: make voice-messages bucket public
-- v90 created it as private, but the code stores and plays back via getPublicUrl()
-- which only works on public buckets. Voice URLs are non-guessable (UUID path)
-- and access is already gated at the message level by RLS.
UPDATE storage.buckets SET public = true WHERE id = 'voice-messages';
