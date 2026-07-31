-- The introduction used to be rendered on every read. It is now generated
-- asynchronously after a profile is saved, so it has to be stored.
-- IF NOT EXISTS keeps this migration replayable on an environment that
-- already has the column.
ALTER TABLE github_users
    ADD COLUMN IF NOT EXISTS introduction text,
    ADD COLUMN IF NOT EXISTS introduction_generated_at timestamptz;
