/**
 * Shared context every rule function reads from. Built once in preflight.ts
 * so rule modules never repeat destination classification or channel
 * inference logic.
 */

import type { DestinationClass, PreflightInput, SegmentInfo } from "../types.js";

export type ChannelAssumption = "imessage" | "sms" | "mms" | "unknown";

export interface RuleContext {
  input: PreflightInput;
  segments: SegmentInfo;
  destination: { raw: string | undefined; class: DestinationClass };
  recipients?: { raw: string; class: DestinationClass }[];
  channel: ChannelAssumption;
  /** `input.body.toLowerCase()`, computed once and shared across rules that
   * need a case-insensitive scan (avoids repeating an O(n) pass per rule). */
  lowerBody: string;
}
