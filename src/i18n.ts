//! Embedded UI strings, copied verbatim from the Rust release's lang/*.json.

import en from "./i18n/en.json";
import zh from "./i18n/zh.json";

/** The English catalog is the shape: every other catalog has to match it
 * field for field, and `satisfies` below is the compile-time completeness
 * check the Rust release got from deserializing each catalog. Deriving
 * the type beats hand-copying it — a key added here cannot be forgotten
 * in the interface. */
export type Lang = typeof en;

export const ALL: ReadonlyArray<readonly [string, Lang]> = [
  ["en", en],
  ["zh", zh satisfies Lang],
];

const FALLBACK: Lang = ALL.find(([code]) => code === "en")![1];

/** Picks the catalog for an IETF language tag: only the primary subtag is
 * considered (`zh-Hans-CN` → `zh`); anything else falls back to English. */
export function resolve(code: string | null | undefined): Lang {
  const primary = code?.split("-")[0]?.toLowerCase();
  return ALL.find(([id]) => id === primary)?.[1] ?? FALLBACK;
}
