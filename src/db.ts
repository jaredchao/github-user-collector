import pg from "pg";
import type { GitHubUser } from "./github.js";

export interface StoredUser extends GitHubUser {
  id: number;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: number;
  username: string;
  github_id: string;
  name: string | null;
  avatar_url: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  public_repos: number;
  followers: number;
  following: number;
  github_created_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// The pool lives at module scope so a warm Lambda container reuses its
// connections instead of exhausting RDS on every invocation. max=2 because a
// single Lambda instance serves one request at a time.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

function toDomain(row: UserRow): StoredUser {
  return {
    id: row.id,
    username: row.username,
    githubId: Number(row.github_id),
    name: row.name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    company: row.company,
    location: row.location,
    publicRepos: row.public_repos,
    followers: row.followers,
    following: row.following,
    githubCreatedAt: row.github_created_at?.toISOString() ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT = `
  INSERT INTO github_users (
    username, github_id, name, avatar_url, bio, company, location,
    public_repos, followers, following, github_created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (username) DO UPDATE SET
    github_id         = EXCLUDED.github_id,
    name              = EXCLUDED.name,
    avatar_url        = EXCLUDED.avatar_url,
    bio               = EXCLUDED.bio,
    company           = EXCLUDED.company,
    location          = EXCLUDED.location,
    public_repos      = EXCLUDED.public_repos,
    followers         = EXCLUDED.followers,
    following         = EXCLUDED.following,
    github_created_at = EXCLUDED.github_created_at,
    updated_at        = now()
  RETURNING *
`;

export async function upsertUser(user: GitHubUser): Promise<StoredUser> {
  const { rows } = await getPool().query<UserRow>(UPSERT, [
    user.username,
    user.githubId,
    user.name,
    user.avatarUrl,
    user.bio,
    user.company,
    user.location,
    user.publicRepos,
    user.followers,
    user.following,
    user.githubCreatedAt,
  ]);

  return toDomain(rows[0]!);
}
