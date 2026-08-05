import { describe, expect, it } from "vitest";
import { newId, normalizePath } from "../src/identity";

describe("normalizePath", () => {
  const cases: Array<[string, string]> = [
    ["/", "/"],
    ["", "/"],
    ["/users", "/users"],
    // Trailing slashes and doubled separators collapse, so /users and
    // /users/ do not become two separate series.
    ["/users/", "/users"],
    ["//users//list//", "/users/list"],
    ["/orders/12345", "/orders/:id"],
    ["/files/deadbeefcafe1234", "/files/:hash"],
    ["/t/3f6b9c1a-1111-2222-3333-444455556666", "/t/:uuid"],
    ["/users/torvalds", "/users/torvalds"],
    ["/a/1/b/2", "/a/:id/b/:id"],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe("newId", () => {
  it("does not repeat across calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });
});
