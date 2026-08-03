import { describe, expect, it, vi } from "vitest";
import { collectPages } from "../src/paginate.js";

describe("collectPages", () => {
  it("单页取完时不算截断", async () => {
    const result = await collectPages<number>(async () => ({ items: [1, 2, 3] }));

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(1);
  });

  it("按 token 一直翻到没有下一页", async () => {
    const pages = [
      { items: [1], nextToken: "t1" },
      { items: [2], nextToken: "t2" },
      { items: [3] },
    ];
    const fetchPage = vi.fn(async (token: string | undefined) => {
      const index = token === undefined ? 0 : Number(token.slice(1));
      return pages[index]!;
    });

    const result = await collectPages<number>(fetchPage);

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("触顶时标记截断，而不是悄悄返回偏小的答案", async () => {
    // 永远还有下一页
    const result = await collectPages<number>(
      async () => ({ items: [1], nextToken: "more" }),
      3,
    );

    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(3);
  });

  it("空结果也是完整结果", async () => {
    const result = await collectPages<number>(async () => ({ items: [] }));

    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
