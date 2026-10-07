import { describe, expect, it } from "vitest";
import { escapeLike, searchTokens } from "./search";

describe("escapeLike", () => {
  it("escapes LIKE metacharacters so they match literally", () => {
    const backslash = String.fromCharCode(92);
    expect(escapeLike("50%")).toBe(`50${backslash}%`);
    expect(escapeLike("a_b")).toBe(`a${backslash}_b`);
    expect(escapeLike(`x${backslash}y`)).toBe(`x${backslash}${backslash}y`);
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("searchTokens", () => {
  it("splits on whitespace, drops empties and caps the number of terms", () => {
    expect(searchTokens("  ada   lovelace ")).toEqual(["ada", "lovelace"]);
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens("a b c d e f g")).toHaveLength(5);
  });
});
