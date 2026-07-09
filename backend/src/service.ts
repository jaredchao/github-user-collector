import { upsertUser, type StoredUser } from "./db.js";
import { fetchUser } from "./github.js";

export async function fetchAndStore(username: string): Promise<StoredUser> {
  const user = await fetchUser(username);
  return upsertUser(user);
}
