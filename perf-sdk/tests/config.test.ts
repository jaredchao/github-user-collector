import { describe, expect, it } from "vitest";
import { resolveConfig, sessionIsSampled } from "../src/config";

const page = () => "/";

describe("resolveConfig", () => {
  it("rejects a config without an endpoint or site", () => {
    expect(() => resolveConfig({ endpoint: "", site: "a" }, page)).toThrow(/endpoint/);
    expect(() => resolveConfig({ endpoint: "https://x", site: "" }, page)).toThrow(/site/);
  });

  it("clamps a sample rate outside 0..1", () => {
    const base = { endpoint: "https://x", site: "s" };
    expect(resolveConfig({ ...base, sampleRate: 2 }, page).sampleRate).toBe(1);
    expect(resolveConfig({ ...base, sampleRate: -1 }, page).sampleRate).toBe(0);
    expect(resolveConfig({ ...base, sampleRate: Number.NaN }, page).sampleRate).toBe(1);
  });

  it("floors the flush interval so a typo cannot spin the network", () => {
    const config = resolveConfig(
      { endpoint: "https://x", site: "s", flushIntervalMs: 1 },
      page,
    );
    expect(config.flushIntervalMs).toBe(1000);
  });
});

describe("sessionIsSampled", () => {
  it("always samples at 1 and never at 0 regardless of the draw", () => {
    expect(sessionIsSampled(1, () => 0.99)).toBe(true);
    expect(sessionIsSampled(0, () => 0)).toBe(false);
  });

  it("compares the draw against the rate", () => {
    expect(sessionIsSampled(0.5, () => 0.49)).toBe(true);
    expect(sessionIsSampled(0.5, () => 0.5)).toBe(false);
  });
});
