import { useState, type FormEvent } from "react";
import { ApiError, fetchUser } from "./api";
import { UserCard } from "./UserCard";
import type { GitHubUser } from "./types";

// One value rather than three booleans: independent isLoading/error/data flags
// can represent contradictory states such as "loading and errored at once".
type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; user: GitHubUser }
  | { status: "error"; message: string };

export function App() {
  const [username, setUsername] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = username.trim();
    if (!trimmed) return;

    setState({ status: "loading" });
    try {
      setState({ status: "success", user: await fetchUser(trimmed) });
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : "出了点问题，请稍后再试";
      setState({ status: "error", message });
    }
  }

  return (
    <main>
      <h1>GitHub 用户查询</h1>
      <p className="subtitle">输入 GitHub 用户名，抓取信息并存入数据库</p>

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="例如 torvalds"
          aria-label="GitHub 用户名"
          autoComplete="off"
        />
        <button type="submit" disabled={state.status === "loading"}>
          {state.status === "loading" ? "查询中…" : "搜索"}
        </button>
      </form>

      {state.status === "error" && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}

      {state.status === "success" && <UserCard user={state.user} />}
    </main>
  );
}
