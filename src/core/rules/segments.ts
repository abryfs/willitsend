/**
 * Segment-derived rules: warns when a small set of non-GSM characters is
 * forcing UCS-2 encoding and inflating the segment count, plus the static
 * daily-cap illustration built from AgentPhone's published quota table.
 */

import { analyzeSegments } from "../segments.js";
import { AGENTPHONE_RATE_LIMITS } from "../sources.js";
import type { CampaignType, Finding, QuotaIllustration } from "../types.js";
import type { RuleContext } from "./context.js";

/** Published T-Mobile 10DLC daily segment caps, by campaign tier. */
const TMOBILE_DAILY_CAPS: Record<CampaignType, number> = {
  sole_proprietor: 1_000,
  low_volume: 2_000,
  high_volume_low_trust: 2_000,
  high_volume_standard: 10_000,
  high_volume_high_trust: 40_000,
  high_volume_highest_trust: 200_000,
};

/** AgentPhone's docs estimate total US carrier capacity as 3x the T-Mobile cap. */
const TOTAL_CAP_MULTIPLIER = 3;

/**
 * Warns when the unique non-GSM characters present are the reason the body
 * needs UCS-2 (and therefore more segments): stripping them out and
 * re-measuring would yield fewer segments.
 */
export function unicodeBlowupFindings(ctx: RuleContext): Finding[] {
  const { segments } = ctx;
  if (segments.encoding !== "ucs2" || segments.nonGsmChars.length === 0) return [];

  const nonGsm = new Set(segments.nonGsmChars);
  const stripped = Array.from(ctx.input.body)
    .filter((ch) => !nonGsm.has(ch))
    .join("");
  const strippedSegments = analyzeSegments(stripped);

  if (strippedSegments.segments >= segments.segments) return [];

  return [
    {
      rule: "segments.unicode-blowup",
      severity: "warn",
      message: `${segments.nonGsmChars.length === 1 ? "Character" : "Characters"} ${segments.nonGsmChars.join(", ")} ${segments.nonGsmChars.length === 1 ? "forces" : "force"} UCS-2 encoding, inflating this message from ${strippedSegments.segments} ${strippedSegments.segments === 1 ? "segment" : "segments"} to ${segments.segments}.`,
      source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
    },
  ];
}

/** Static daily-cap illustration; not a finding, just trace data. */
export function buildQuotaIllustration(
  campaignType: CampaignType | undefined,
  segmentsPerMessage: number,
): QuotaIllustration | undefined {
  if (campaignType === undefined || segmentsPerMessage === 0) return undefined;

  const tmobileDailyCap = TMOBILE_DAILY_CAPS[campaignType];
  const estimatedTotalDailyCap = tmobileDailyCap * TOTAL_CAP_MULTIPLIER;

  return {
    campaign_type: campaignType,
    segments_per_message: segmentsPerMessage,
    tmobile_daily_cap: tmobileDailyCap,
    estimated_total_daily_cap: estimatedTotalDailyCap,
    messages_per_day_estimate: Math.floor(estimatedTotalDailyCap / segmentsPerMessage),
    note:
      "Rough estimate from AgentPhone's published T-Mobile 10DLC daily segment cap, tripled " +
      "per their docs to approximate total US carrier capacity. Not a delivery guarantee.",
  };
}
