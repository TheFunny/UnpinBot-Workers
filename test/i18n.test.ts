//! Catalog completeness and language resolution — ported from the Rust
//! release's i18n.rs suite (the JSON walk replaces serde's parse check).

import { describe, expect, it } from "vitest";

import { ALL, resolve } from "../src/i18n";

describe("embedded catalogs", () => {
  it("every string in every catalog is non-empty", () => {
    // Walking the value keeps future keys covered without touching this test.
    function walk(code: string, path: string, value: unknown): void {
      if (typeof value === "string") {
        expect(value, `${code}:${path} is empty`).not.toBe("");
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => walk(code, `${path}[${i}]`, item));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          expect(key, `${code}:${path} has an empty key`).not.toBe("");
          walk(code, `${path}.${key}`, item);
        }
      } else {
        throw new Error(`${code}:${path} is not a string: ${typeof value}`);
      }
    }
    for (const [code, lang] of ALL) walk(code, "", lang);
  });

  it("declares exactly the shipped language list", () => {
    expect(ALL.map(([code]) => code)).toEqual(["en", "zh"]);
  });
});

describe("resolve", () => {
  it("matches the primary subtag with English fallback", () => {
    const en = resolve("en").start;
    const zh = resolve("zh").start;
    expect(en).not.toBe(zh);

    expect(resolve(undefined).start).toBe(en);
    expect(resolve("zh-Hans-CN").start).toBe(zh);
    expect(resolve("ZH").start).toBe(zh);
    expect(resolve("pt-BR").start).toBe(en);
    expect(resolve("jp").start).toBe(en);
  });
});
