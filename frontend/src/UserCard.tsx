import type { GitHubUser } from "./types";

const numberFormat = new Intl.NumberFormat("en-US");

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{numberFormat.format(value)}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

export function UserCard({ user }: { user: GitHubUser }) {
  const joined = user.githubCreatedAt
    ? new Date(user.githubCreatedAt).toLocaleDateString("zh-CN")
    : null;

  return (
    <article className="card">
      {user.avatarUrl && (
        <img className="avatar" src={user.avatarUrl} alt={`${user.username} 的头像`} />
      )}

      <h2>{user.name ?? user.username}</h2>

      <a className="handle" href={`https://github.com/${user.username}`} target="_blank" rel="noreferrer">
        @{user.username}
      </a>

      {user.bio && (
        <p className="bio" data-testid="bio">
          {user.bio}
        </p>
      )}

      <dl className="meta">
        {user.company && (
          <div data-testid="company">
            <dt>公司</dt>
            <dd>{user.company}</dd>
          </div>
        )}
        {user.location && (
          <div data-testid="location">
            <dt>所在地</dt>
            <dd>{user.location}</dd>
          </div>
        )}
        {joined && (
          <div data-testid="joined">
            <dt>加入于</dt>
            <dd>{joined}</dd>
          </div>
        )}
      </dl>

      <div className="stats">
        <Stat label="仓库" value={user.publicRepos} />
        <Stat label="粉丝" value={user.followers} />
        <Stat label="关注" value={user.following} />
      </div>
    </article>
  );
}
