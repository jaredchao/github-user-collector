CREATE TABLE IF NOT EXISTS github_users (
  id                SERIAL PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  github_id         BIGINT NOT NULL,
  name              TEXT,
  avatar_url        TEXT,
  bio               TEXT,
  company           TEXT,
  location          TEXT,
  public_repos      INTEGER NOT NULL DEFAULT 0,
  followers         INTEGER NOT NULL DEFAULT 0,
  following         INTEGER NOT NULL DEFAULT 0,
  github_created_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
