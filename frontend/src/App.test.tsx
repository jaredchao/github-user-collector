import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, fetchUser: vi.fn(), fetchIntro: vi.fn() };
});

const { fetchUser, fetchIntro } = await import("./api");
const { App } = await import("./App");

const user = {
  id: 1,
  username: "torvalds",
  githubId: 1024025,
  name: "Linus Torvalds",
  avatarUrl: "https://example.com/a.png",
  bio: null,
  company: null,
  location: null,
  publicRepos: 12,
  followers: 311029,
  following: 0,
  githubCreatedAt: null,
  createdAt: "2026-07-09T07:54:36.341Z",
  updatedAt: "2026-07-09T07:54:36.341Z",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(fetchUser).mockReset();
  // Default: intro resolves, so existing user-card tests aren't affected by the
  // second request that now fires after a successful search.
  vi.mocked(fetchIntro).mockReset().mockResolvedValue("some intro");
});

describe("App intro section", () => {
  it("shows the intro under the card after a successful search", async () => {
    vi.mocked(fetchUser).mockResolvedValue(user as never);
    vi.mocked(fetchIntro).mockResolvedValue("Linus 的个人介绍");

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "torvalds");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    expect(await screen.findByText("Linus 的个人介绍")).toBeInTheDocument();
    expect(fetchIntro).toHaveBeenCalledWith("torvalds");
  });

  it("keeps the card when the intro fails", async () => {
    vi.mocked(fetchUser).mockResolvedValue(user as never);
    vi.mocked(fetchIntro).mockRejectedValue(new ApiError("介绍服务暂时不可用", 503));

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "torvalds");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    // Card still shows even though the intro errored.
    expect(await screen.findByText("Linus Torvalds")).toBeInTheDocument();
    expect(await screen.findByText("介绍服务暂时不可用")).toBeInTheDocument();
  });

  it("does not fetch intro when the search itself fails", async () => {
    vi.mocked(fetchUser).mockRejectedValue(new ApiError("找不到这个 GitHub 用户", 404));

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "nobody");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await screen.findByRole("alert");
    expect(fetchIntro).not.toHaveBeenCalled();
  });
});

describe("App", () => {
  it("starts with no card and no error", () => {
    render(<App />);

    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the user card after a successful search", async () => {
    vi.mocked(fetchUser).mockResolvedValue(user as never);

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "torvalds");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    expect(await screen.findByText("Linus Torvalds")).toBeInTheDocument();
    expect(fetchUser).toHaveBeenCalledWith("torvalds");
  });

  it("disables the button and shows progress while loading", async () => {
    const d = deferred<typeof user>();
    vi.mocked(fetchUser).mockReturnValue(d.promise as never);

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "torvalds");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText(/查询中/)).toBeInTheDocument();

    d.resolve(user);
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  });

  it("shows the error message when the search fails", async () => {
    vi.mocked(fetchUser).mockRejectedValue(new ApiError("找不到这个 GitHub 用户", 404));

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "nobody");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("找不到这个 GitHub 用户");
  });

  // A stale error left on screen next to a fresh result is the classic bug of
  // tracking loading/error/data as independent flags.
  it("clears a previous error when a new search succeeds", async () => {
    vi.mocked(fetchUser).mockRejectedValueOnce(new ApiError("找不到这个 GitHub 用户", 404));

    render(<App />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "nobody");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));
    await screen.findByRole("alert");

    vi.mocked(fetchUser).mockResolvedValueOnce(user as never);
    await userEvent.clear(input);
    await userEvent.type(input, "torvalds");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    expect(await screen.findByText("Linus Torvalds")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a previous card when a new search fails", async () => {
    vi.mocked(fetchUser).mockResolvedValueOnce(user as never);

    render(<App />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "torvalds");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));
    await screen.findByText("Linus Torvalds");

    vi.mocked(fetchUser).mockRejectedValueOnce(new ApiError("找不到这个 GitHub 用户", 404));
    await userEvent.clear(input);
    await userEvent.type(input, "nobody");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await screen.findByRole("alert");
    expect(screen.queryByText("Linus Torvalds")).not.toBeInTheDocument();
  });

  it("does not search when the input is empty", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    expect(fetchUser).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before searching", async () => {
    vi.mocked(fetchUser).mockResolvedValue(user as never);

    render(<App />);
    await userEvent.type(screen.getByRole("textbox"), "  torvalds  ");
    await userEvent.click(screen.getByRole("button", { name: /搜索/ }));

    await waitFor(() => expect(fetchUser).toHaveBeenCalledWith("torvalds"));
  });
});
