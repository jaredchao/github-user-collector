// The intro section shown under the user card. Its state is independent of the
// user card: it can be loading or errored while the card is fully shown.
export type IntroState =
  | { status: "loading" }
  | { status: "success"; intro: string }
  | { status: "error"; message: string };

export function IntroCard({ state }: { state: IntroState }) {
  return (
    <section className="intro" aria-label="个人介绍">
      <h3>个人介绍</h3>
      {state.status === "loading" && <p className="intro-muted">生成介绍中…</p>}
      {state.status === "error" && (
        <p className="intro-muted" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "success" && <p className="intro-text">{state.intro}</p>}
    </section>
  );
}
