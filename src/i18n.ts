//! Embedded UI strings, copied verbatim from the Rust release's lang/*.json.

import en from "./i18n/en.json";
import zh from "./i18n/zh.json";

export interface Lang {
  start: string;
  help: string;
  enable: string;
  disable: string;
  error: {
    not_group: string;
    not_admin: string;
    require_rights: string;
    rights_revoked: string;
    already_enabled: string;
    already_disabled: string;
    retry_later: string;
  };
  cmd: {
    start: string;
    help: string;
    enable: string;
    disable: string;
  };
  description: string;
}

// The annotation is the compile-time completeness check: the Rust release
// got the same guarantee from serde deserializing each catalog.
export const ALL: ReadonlyArray<readonly [string, Lang]> = [
  ["en", en],
  ["zh", zh],
];

const FALLBACK: Lang = ALL.find(([code]) => code === "en")![1];

/** Picks the catalog for an IETF language tag: only the primary subtag is
 * considered (`zh-Hans-CN` → `zh`); anything else falls back to English. */
export function resolve(code: string | null | undefined): Lang {
  const primary = code?.split("-")[0]?.toLowerCase();
  return ALL.find(([id]) => id === primary)?.[1] ?? FALLBACK;
}
