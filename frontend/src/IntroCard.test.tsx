import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntroCard } from "./IntroCard";

describe("IntroCard", () => {
  it("shows a loading hint while generating", () => {
    render(<IntroCard state={{ status: "loading" }} />);
    expect(screen.getByText(/生成介绍中/)).toBeInTheDocument();
  });

  it("shows the intro text on success", () => {
    render(<IntroCard state={{ status: "success", intro: "Linus Torvalds ..." }} />);
    expect(screen.getByText("Linus Torvalds ...")).toBeInTheDocument();
  });

  it("shows the error as an alert without breaking", () => {
    render(<IntroCard state={{ status: "error", message: "介绍服务暂时不可用" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("介绍服务暂时不可用");
  });
});
