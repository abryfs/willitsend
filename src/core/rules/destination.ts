/**
 * Destination validity and line-type findings. Destination *classification*
 * lives in ../destination.ts; this module only turns an already-classified
 * destination into findings.
 */

import { AGENTPHONE_MESSAGES, AGENTPHONE_RATE_LIMITS } from "../sources.js";
import type { Finding } from "../types.js";
import type { RuleContext } from "./context.js";

/** `to_number`, and each `recipients` entry, must classify to a known format. */
export function destinationFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];

  if (ctx.destination.raw !== undefined && ctx.destination.class === "unknown") {
    findings.push({
      rule: "destination.invalid",
      severity: "block",
      message: `"${ctx.destination.raw}" doesn't match a recognized destination format (E.164 phone, email, short code, or group id).`,
      source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
    });
  }

  for (const recipient of ctx.recipients ?? []) {
    if (recipient.class !== "unknown") continue;
    findings.push({
      rule: "destination.invalid",
      severity: "block",
      message: `Recipient "${recipient.raw}" doesn't match a recognized destination format (E.164 phone, email, short code, or group id).`,
      source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
      recipient: recipient.raw,
    });
  }

  return findings;
}

/** VoIP lines are only ever flagged when a lookup confirmed it — never guessed. */
export function voipFindings(ctx: RuleContext): Finding[] {
  if (ctx.input.destination_line_type !== "voip") return [];
  return [
    {
      rule: "destination.voip",
      severity: "warn",
      message:
        "Destination is a VoIP line. VoIP numbers often have unreliable SMS/MMS delivery and " +
        "may not support iMessage at all.",
      source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
    },
  ];
}
