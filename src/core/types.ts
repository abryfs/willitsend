/**
 * Core types for willitsend.
 *
 * Everything in `src/core` is a pure function of its inputs: no network,
 * no clock, no environment. Callers that want live data (e.g. a contact
 * capabilities lookup) fetch it themselves and pass the result in.
 */

/** How the destination string was classified. */
export type DestinationClass =
  | "e164" // +15551234567 — SMS or iMessage
  | "email" // iMessage only
  | "short_code" // 5-6 digit sender/recipient
  | "group_id" // grp_… — iMessage group, iMessage only
  | "unknown";

/** Message encodings on the SMS path. */
export type Encoding = "gsm7" | "ucs2" | "none";

/** iMessage send_style values accepted by the AgentPhone API. */
export const SEND_STYLES = [
  "celebration",
  "fireworks",
  "lasers",
  "love",
  "confetti",
  "balloons",
  "spotlight",
  "echo",
  "invisible",
  "gentle",
  "loud",
  "slam",
] as const;
export type SendStyle = (typeof SEND_STYLES)[number];

/** 10DLC campaign tiers as published in AgentPhone's rate-limit docs. */
export const CAMPAIGN_TYPES = [
  "sole_proprietor",
  "low_volume",
  "high_volume_low_trust",
  "high_volume_standard",
  "high_volume_high_trust",
  "high_volume_highest_trust",
] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export interface DestinationCapabilities {
  imessage: boolean;
  sms: boolean;
}

export type LineType = "mobile" | "voip" | "landline" | "unknown";

/** Input to preflight(). Only `body` is required. */
export interface PreflightInput {
  /** Message text. May be empty for media-only sends. */
  body: string;
  /** Single destination: E.164, email, short code, or grp_ id. */
  to_number?: string;
  /** 2+ entries creates a new iMessage group (iMessage only). */
  recipients?: string[];
  /** Media attachments. 2-20 entries = iMessage carousel. */
  media_urls?: string[];
  /** iMessage-only visual effect. */
  send_style?: string;
  /** iMessage-only threaded reply target. */
  reply_to_message_id?: string;
  /**
   * Is this the first outbound message to this contact?
   * undefined = unknown; first-message rules then report conditionally
   * instead of asserting.
   */
  is_first_message_to_contact?: boolean;
  /** Brand name to verify in first messages. Without it the brand rule
   * degrades to advisory ("provide brand_name to verify"). */
  brand_name?: string;
  /** Whether the recipient's opt-in is confirmed upstream. This tool can
   * only check for the presence of opt-in language, never that consent
   * actually exists. */
  opt_in_context?: "confirmed" | "unknown";
  /** Enables the daily-cap illustration (static math from published caps). */
  campaign_type?: CampaignType;
  /** Result of a live capabilities lookup, if the caller performed one. */
  destination_capabilities?: DestinationCapabilities;
  /** Destination line type, if the caller knows it (e.g. from a lookup
   * service). Never guessed from the number itself. */
  destination_line_type?: LineType;
}

export type Severity = "block" | "warn" | "info";

/** Where a rule's authority comes from. Independent of severity. */
export type SourceKind = "agentphone-docs" | "ctia" | "twilio" | "heuristic";

export interface FindingSource {
  kind: SourceKind;
  url: string;
}

/**
 * Context a conditional finding depends on. A finding with `condition`
 * means: "IF this context holds, the severity applies" — the input didn't
 * say either way.
 */
export type Condition =
  | "first_message" // is_first_message_to_contact was undefined
  | "sms_fallback" // destination capabilities unknown; may deliver as SMS
  | "voip_destination"; // line type unknown

export interface Finding {
  /** Stable rule id, e.g. "first-message.opt-out". */
  rule: string;
  severity: Severity;
  /** Present when the finding only applies under unknown context. */
  condition?: Condition;
  /** What's wrong, in one or two sentences. */
  message: string;
  /** Concrete remediation, e.g. text to append. */
  fix?: string;
  source: FindingSource;
  /** Rules whose checks are language-specific declare it. */
  locale?: "en";
  /** For per-recipient findings: which destination triggered it. */
  recipient?: string;
}

export interface SegmentInfo {
  encoding: Encoding;
  /** Septets for gsm7 (extension chars cost 2), UTF-16 code units for ucs2. */
  units: number;
  /** Unicode code points in the body. */
  chars: number;
  /** Number of SMS segments after placement-aware packing. */
  segments: number;
  /** Units packed into each segment. Sums to `units`. */
  perSegment: number[];
  /** Unique characters that forced UCS-2 (capped at 10). */
  nonGsmChars: string[];
  /** Unique GSM extension-table characters present (each costs 2 septets). */
  extensionChars: string[];
}

/** Static daily-cap illustration from AgentPhone's published table. */
export interface QuotaIllustration {
  campaign_type: CampaignType;
  segments_per_message: number;
  /** Published T-Mobile daily segment cap for this tier. */
  tmobile_daily_cap: number;
  /** Their docs' guidance: estimate total US capacity as 3x T-Mobile. */
  estimated_total_daily_cap: number;
  /** Messages of this size that fit in the estimated total daily cap. */
  messages_per_day_estimate: number;
  note: string;
}

/** The send trace: what we believe will happen to this message. */
export interface SendTrace {
  destination: { raw: string | undefined; class: DestinationClass };
  /** Additional destinations when `recipients` was used. */
  recipients?: { raw: string; class: DestinationClass }[];
  /** Best guess at the delivery channel given available context. */
  channel_assumption: "imessage" | "sms" | "mms" | "unknown";
  segments: SegmentInfo;
  quota?: QuotaIllustration;
  notes: string[];
}

export type Verdict = "pass" | "warn" | "block" | "needs_context";

export interface PreflightReport {
  /**
   * pass    — no findings above info
   * warn    — warn findings, nothing blocking
   * block   — at least one unconditional block finding
   * needs_context — block-severity findings exist but depend on context
   *                 the input didn't provide (they carry `condition`)
   */
  verdict: Verdict;
  findings: Finding[];
  trace: SendTrace;
}

/** Thrown (CLI/MCP map it to usage errors) when input is unusable. */
export class PreflightInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightInputError";
  }
}

/** Hard cap on body length; longer input is a usage error, not a finding. */
export const MAX_BODY_LENGTH = 10_000;
