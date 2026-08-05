import { describe, expect, it } from "vitest";
import { validatePayload } from "../src/validate.js";

const NOW = 1_800_000_000_000;

function payload(overrides: Record<string, unknown> = {}, eventOverrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sdk: "perf-sdk@1.0.0",
    site: "demo",
    session: "s-1",
    page: "/users/:id",
    ua: "Mozilla/5.0",
    conn: "4g",
    events: [
      { id: "e-1", name: "LCP", value: 1800, rating: "good", at: NOW, ...eventOverrides },
    ],
    ...overrides,
  };
}

describe("validatePayload", () => {
  it("flattens payload context into every record", () => {
    const result = validatePayload(payload(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual({
      v: 1,
      sdk: "perf-sdk@1.0.0",
      site: "demo",
      session: "s-1",
      page: "/users/:id",
      ua: "Mozilla/5.0",
      conn: "4g",
      id: "e-1",
      name: "LCP",
      value: 1800,
      rating: "good",
      at: NOW,
      attrs: {},
    });
  });

  const rejections: Array<[string, unknown]> = [
    ["非对象", "not an object"],
    ["null", null],
    ["数组", []],
    ["版本不匹配", payload({ v: 2 })],
    ["缺 site", payload({ site: "" })],
    ["缺 session", payload({ session: 123 })],
    ["缺 page", payload({ page: null })],
    ["events 不是数组", payload({ events: {} })],
    ["events 为空", payload({ events: [] })],
    ["events 过多", payload({ events: Array.from({ length: 51 }, () => ({ id: "x", name: "LCP", value: 1, rating: "good", at: NOW })) })],
  ];

  it.each(rejections)("拒绝 %s", (_label, input) => {
    expect(validatePayload(input, NOW).ok).toBe(false);
  });

  // A single malformed event should not cost the whole session's data.
  it("drops bad events but keeps the good ones", () => {
    const result = validatePayload(
      payload({
        events: [
          { id: "ok", name: "LCP", value: 1000, rating: "good", at: NOW },
          { id: "bad-metric", name: "MADE_UP", value: 1, rating: "good", at: NOW },
          { id: "bad-value", name: "LCP", value: -5, rating: "good", at: NOW },
          { id: "huge-value", name: "LCP", value: 1e9, rating: "good", at: NOW },
          { id: "bad-rating", name: "LCP", value: 1, rating: "terrible", at: NOW },
          { id: "", name: "LCP", value: 1, rating: "good", at: NOW },
          { name: "LCP", value: Number.NaN, rating: "good", at: NOW },
        ],
      }),
      NOW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => r.id)).toEqual(["ok"]);
    expect(result.dropped).toBe(6);
  });

  it("fails when every event is unusable", () => {
    const result = validatePayload(payload({ events: [{ id: "x", name: "NOPE" }] }), NOW);
    expect(result.ok).toBe(false);
  });

  describe("clock skew", () => {
    it("keeps a timestamp inside the tolerated window", () => {
      const result = validatePayload(payload({}, { at: NOW - 60_000 }), NOW);
      expect(result.ok && result.records[0]?.at).toBe(NOW - 60_000);
    });

    // A wrong device clock is common. Replacing the timestamp keeps the
    // sample, and the marker keeps it explainable.
    it.each([
      ["太旧", NOW - 48 * 60 * 60 * 1000],
      ["未来", NOW + 60 * 60 * 1000],
      ["非数字", "yesterday"],
    ])("用接收时间替换 %s 的时间戳并打标", (_label, at) => {
      const result = validatePayload(payload({}, { at }), NOW);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.records[0]?.at).toBe(NOW);
      expect(result.records[0]?.attrs).toEqual({ clock: "skewed" });
    });
  });

  describe("attrs sanitation", () => {
    it("keeps strings and finite numbers, drops the rest", () => {
      const result = validatePayload(
        payload({}, { attrs: { url: "/a", bytes: 12, nested: { a: 1 }, list: [1], flag: true, nan: Number.NaN } }),
        NOW,
      );
      expect(result.ok && result.records[0]?.attrs).toEqual({ url: "/a", bytes: 12 });
    });

    it("truncates long keys and values and caps the key count", () => {
      const attrs = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v"]));
      const result = validatePayload(payload({}, { attrs: { ...attrs, long: "x".repeat(500) } }), NOW);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.records[0]?.attrs ?? {})).toHaveLength(12);

      const single = validatePayload(payload({}, { attrs: { ["k".repeat(80)]: "x".repeat(500) } }), NOW);
      expect(single.ok).toBe(true);
      if (!single.ok) return;
      const [key, value] = Object.entries(single.records[0]?.attrs ?? {})[0] ?? [];
      expect(key).toHaveLength(40);
      expect(String(value)).toHaveLength(200);
    });

    it("ignores attrs that are not an object", () => {
      expect(validatePayload(payload({}, { attrs: "nope" }), NOW).ok).toBe(true);
    });
  });

  it("truncates oversized context fields instead of rejecting them", () => {
    const result = validatePayload(payload({ ua: "u".repeat(2000), page: "/p".repeat(500) }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[0]?.ua).toHaveLength(512);
    expect(result.records[0]?.page).toHaveLength(200);
  });
});
