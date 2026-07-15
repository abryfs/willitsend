/**
 * Classifies a raw destination string into a `DestinationClass`.
 *
 * All patterns are anchored, fixed-width character classes — no nested
 * quantifiers or alternation that could backtrack on adversarial input.
 */

import type { DestinationClass } from "./types.js";

const E164_RE = /^\+[1-9]\d{6,14}$/;
const SHORT_CODE_RE = /^\d{5,6}$/;
const GROUP_ID_RE = /^grp_[A-Za-z0-9_-]+$/;

/** Exactly one `@`, non-empty local/domain parts, and a dot in the domain. */
function isEmail(raw: string): boolean {
  const atIndex = raw.indexOf("@");
  if (atIndex === -1) return false;
  if (raw.indexOf("@", atIndex + 1) !== -1) return false;
  const local = raw.slice(0, atIndex);
  const domain = raw.slice(atIndex + 1);
  if (local.length === 0 || domain.length === 0) return false;
  return domain.includes(".");
}

/** Classifies `raw` as an E.164 phone, email, short code, group id, or unknown. */
export function classifyDestination(raw: string): DestinationClass {
  if (E164_RE.test(raw)) return "e164";
  if (SHORT_CODE_RE.test(raw)) return "short_code";
  if (isEmail(raw)) return "email";
  if (GROUP_ID_RE.test(raw)) return "group_id";
  return "unknown";
}
