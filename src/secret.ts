/** Constant-time-ish comparison for credential headers: no early exit on
 * the first differing byte, only an accumulated difference. */
export function keysMatch(a: string, b: string): boolean {
  // Fail closed on an absent key. `TextEncoder.encode(undefined)` yields
  // the empty array, not the literal "undefined", so a request with no
  // header compared against an unset secret would otherwise match on two
  // empty strings and authenticate the caller.
  if (!a || !b) return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
