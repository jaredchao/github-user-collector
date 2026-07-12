import { useState, type FormEvent } from "react";
import { ApiError, fetchIntro, fetchUser } from "./api";
import { IntroCard, type IntroState } from "./IntroCard";
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
  // The intro is fetched separately (Lambda -> Cloud Map -> Go) so its failure
  // never hides the user card, and vice versa.
  const [intro, setIntro] = useState<IntroState | null>(null);

  async function loadIntro(name: string) {
    setIntro({ status: "loading" });
    try {
      setIntro({ status: "success", intro: await fetchIntro(name) });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "介绍生成失败";
      setIntro({ status: "error", message });
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const trimmed = username.trim();
    if (!trimmed) return;

    setState({ status: "loading" });
    setIntro(null);
    try {
      const user = await fetchUser(trimmed);
      setState({ status: "success", user });
      // Fire the second request only after the user exists in the database.
      void loadIntro(user.username);
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

      {state.status === "success" && (
        <>
          <UserCard user={state.user} />
          {intro && <IntroCard state={intro} />}
        </>
      )}
    </main>
  );
}
