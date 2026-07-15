/**
 * preflight(): validates input, classifies the destination, runs every rule
 * family, and aggregates the result into a verdict + trace. Pure function —
 * no I/O, no clock.
 */

import { classifyDestination } from "./destination.js";
import { destinationFindings, voipFindings } from "./rules/destination.js";
import { firstMessageFindings } from "./rules/firstMessage.js";
import {
  carouselCountFindings,
  featureFallbackFindings,
  invalidSendStyleFindings,
  newContactCapFindings,
} from "./rules/imessage.js";
import { shaftFindings, spamPatternFindings, urlShortenerFindings } from "./rules/content.js";
import { buildQuotaIllustration, unicodeBlowupFindings } from "./rules/segments.js";
import type { ChannelAssumption, RuleContext } from "./rules/context.js";
import { analyzeSegments } from "./segments.js";
import { MAX_BODY_LENGTH, PreflightInputError } from "./types.js";
import type {
  DestinationClass,
  Finding,
  PreflightInput,
  PreflightReport,
  SendTrace,
  Verdict,
} from "./types.js";

const SEVERITY_RANK: Record<Finding["severity"], number> = { block: 0, warn: 1, info: 2 };

function validate(input: PreflightInput): void {
  if (input.body.length > MAX_BODY_LENGTH) {
    throw new PreflightInputError(`body exceeds the ${MAX_BODY_LENGTH}-character limit.`);
  }
  const hasMedia = input.media_urls !== undefined && input.media_urls.length > 0;
  if (input.body.length === 0 && !hasMedia) {
    throw new PreflightInputError("body is empty and no media_urls were provided; nothing to send.");
  }
  if (input.to_number !== undefined && input.recipients !== undefined) {
    throw new PreflightInputError("Provide either to_number or recipients, not both.");
  }
}

function resolveChannel(
  input: PreflightInput,
  destinationClass: DestinationClass,
  hasRecipients: boolean,
): ChannelAssumption {
  // A group send (2+ recipients) always creates an iMessage group.
  if (hasRecipients) return "imessage";

  const caps = input.destination_capabilities;
  if (caps?.imessage === true) return "imessage";
  if (destinationClass === "email" || destinationClass === "group_id") return "imessage";
  if (caps?.imessage === false) {
    const hasMedia = input.media_urls !== undefined && input.media_urls.length > 0;
    return hasMedia ? "mms" : "sms";
  }
  return "unknown";
}

function computeVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "block" && f.condition === undefined)) return "block";
  if (findings.some((f) => f.severity === "block")) return "needs_context";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

/** Runs every preflight rule against `input` and returns a full report. */
export function preflight(input: PreflightInput): PreflightReport {
  validate(input);

  const segments = analyzeSegments(input.body);

  let destination: { raw: string | undefined; class: DestinationClass };
  let recipients: { raw: string; class: DestinationClass }[] | undefined;
  if (input.recipients !== undefined) {
    recipients = input.recipients.map((raw) => ({ raw, class: classifyDestination(raw) }));
    destination = { raw: undefined, class: "unknown" };
  } else if (input.to_number !== undefined) {
    destination = { raw: input.to_number, class: classifyDestination(input.to_number) };
  } else {
    destination = { raw: undefined, class: "unknown" };
  }

  const channel = resolveChannel(input, destination.class, recipients !== undefined);

  const ctx: RuleContext = {
    input,
    segments,
    destination,
    ...(recipients ? { recipients } : {}),
    channel,
  };

  const findings: Finding[] = [
    ...firstMessageFindings(ctx),
    ...destinationFindings(ctx),
    ...voipFindings(ctx),
    ...invalidSendStyleFindings(ctx),
    ...carouselCountFindings(ctx),
    ...featureFallbackFindings(ctx),
    ...newContactCapFindings(ctx),
    ...shaftFindings(ctx),
    ...urlShortenerFindings(ctx),
    ...spamPatternFindings(ctx),
    ...unicodeBlowupFindings(ctx),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const notes: string[] = [];
  if (destination.raw !== undefined && input.destination_line_type === undefined) {
    notes.push(
      `Line type for ${destination.raw} is unknown to this tool; if it's VoIP, delivery may be unreliable and iMessage may not be supported.`,
    );
  } else if (destination.raw !== undefined && input.destination_line_type === "unknown") {
    notes.push(
      `Line type for ${destination.raw} was looked up but came back unknown; if it's VoIP, delivery may be unreliable.`,
    );
  }

  const quota = buildQuotaIllustration(input.campaign_type, segments.segments);

  const trace: SendTrace = {
    destination,
    ...(recipients ? { recipients } : {}),
    channel_assumption: channel,
    segments,
    ...(quota ? { quota } : {}),
    notes,
  };

  return { verdict: computeVerdict(findings), findings, trace };
}
