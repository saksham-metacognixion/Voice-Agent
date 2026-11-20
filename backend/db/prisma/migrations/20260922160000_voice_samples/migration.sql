-- W3 voice samples (ADR 0003 §9).
--
-- The provider's catalogue clips say the vendor's name out loud, and there is no
-- text-to-speech route to synthesise a clean one with. `sample_url` holds a clip of our
-- own when we have recorded one; it is played in preference to the provider's, and the
-- daily `voice-cache` job never writes it.
ALTER TABLE "voices" ADD COLUMN IF NOT EXISTS "sample_url" TEXT;
