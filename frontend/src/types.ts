export interface GitHubUser {
  id: number;
  username: string;
  githubId: number;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  githubCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
