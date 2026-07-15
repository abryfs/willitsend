/**
 * First-message compliance rules. AgentPhone's docs say non-compliant first
 * messages "may be silently filtered by carriers" with no API error, so
 * these are block-severity — the highest confidence tier in this tool.
 *
 * Rules run when `is_first_message_to_contact` is true (unconditional) or
 * undefined (conditional on `first_message`); they stay silent when it's
 * explicitly false.
 */

import { AGENTPHONE_MESSAGES, AGENTPHONE_RATE_LIMITS } from "../sources.js";
import type { Condition, Finding, PreflightInput } from "../types.js";
import type { RuleContext } from "./context.js";

const TRIGGER_WORDS = ["reply", "text", "send"];
const OPT_OUT_WORDS = ["stop", "end", "quit", "cancel", "unsubscribe", "opt out", "opt-out"];
/** How far past a trigger word we look for an opt-out keyword. */
const WINDOW = 40;

const OPT_IN_PHRASES = [
  "thanks for signing up",
  "thank you for signing up",
  "thanks for subscribing",
  "thank you for subscribing",
  "thanks for joining",
  "thank you for joining",
  "thanks for opting in",
  "thank you for opting in",
  "you signed up",
  "you subscribed",
  "you opted in",
  "you requested",
  "you agreed",
  "you asked",
];

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

/** Whole-word (or whole-phrase) substring search within `text`. */
function containsWord(text: string, word: string): boolean {
  let idx = 0;
  while ((idx = text.indexOf(word, idx)) !== -1) {
    const before = idx === 0 ? undefined : text[idx - 1];
    const afterIdx = idx + word.length;
    const after = afterIdx === text.length ? undefined : text[afterIdx];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    idx += word.length;
  }
  return false;
}

/**
 * Instruction-shaped opt-out detection: an opt-out keyword must appear
 * shortly after (within `WINDOW` chars of) a trigger word like "reply" or
 * "text", so "never stop improving" doesn't count but "Reply STOP" does.
 * Linear scan — no backtracking regex — so it stays fast on adversarial
 * input (e.g. "STOP ".repeat(1900)).
 */
function hasOptOutInstruction(body: string): boolean {
  const lower = body.toLowerCase();
  for (const trigger of TRIGGER_WORDS) {
    let idx = 0;
    while ((idx = lower.indexOf(trigger, idx)) !== -1) {
      const before = idx === 0 ? undefined : lower[idx - 1];
      const wordEnd = idx + trigger.length;
      const after = wordEnd === lower.length ? undefined : lower[wordEnd];
      if (!isWordChar(before) && !isWordChar(after)) {
        const window = lower.slice(wordEnd, Math.min(lower.length, wordEnd + WINDOW));
        for (const keyword of OPT_OUT_WORDS) {
          if (containsWord(window, keyword)) return true;
        }
      }
      idx = wordEnd;
    }
  }
  return false;
}

function withCondition(condition: Condition | undefined): { condition?: Condition } {
  return condition ? { condition } : {};
}

function optOutFindings(body: string, condition: Condition | undefined): Finding[] {
  if (hasOptOutInstruction(body)) return [];
  return [
    {
      rule: "first-message.opt-out",
      severity: "block",
      ...withCondition(condition),
      message:
        "First message doesn't include opt-out instructions (e.g. \"Reply STOP to unsubscribe\"). " +
        "Carriers may silently filter first messages that lack one, with no API error.",
      fix: 'Append "Reply STOP to unsubscribe." to the message body.',
      source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
      locale: "en",
    },
  ];
}

function brandFindings(input: PreflightInput, condition: Condition | undefined): Finding[] {
  if (input.brand_name === undefined) {
    return [
      {
        rule: "first-message.brand",
        severity: "info",
        ...withCondition(condition),
        message:
          "No brand_name was provided, so this tool can't verify the message identifies your " +
          "brand. Provide brand_name to check for it.",
        source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
      },
    ];
  }

  const normalize = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ");
  const normBrand = normalize(input.brand_name);
  if (normBrand.length > 0 && normalize(input.body).includes(normBrand)) return [];

  return [
    {
      rule: "first-message.brand",
      severity: "block",
      ...withCondition(condition),
      message: `Message body doesn't mention the brand "${input.brand_name}". First messages must identify the sender.`,
      fix: `Include "${input.brand_name}" in the message body.`,
      source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
    },
  ];
}

function optInFindings(input: PreflightInput, condition: Condition | undefined): Finding[] {
  const lower = input.body.toLowerCase();
  if (OPT_IN_PHRASES.some((phrase) => lower.includes(phrase))) return [];
  return [
    {
      rule: "first-message.opt-in",
      severity: "warn",
      ...withCondition(condition),
      message:
        "No opt-in acknowledgment language found (e.g. \"thanks for signing up\"). This only " +
        "checks for the presence of opt-in language, never that consent actually exists.",
      source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
    },
  ];
}

function mediaOnlyFindings(condition: Condition | undefined): Finding[] {
  return [
    {
      rule: "first-message.media-only",
      severity: "warn",
      ...withCondition(condition),
      message:
        "This is a media-only first message. Compliance text (brand, opt-in, opt-out) can't " +
        "ride in an image, and carriers may filter first messages that lack it.",
      source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
    },
  ];
}

/** Runs all first-message rules against the shared context. */
export function firstMessageFindings(ctx: RuleContext): Finding[] {
  const state = ctx.input.is_first_message_to_contact;
  if (state === false) return [];
  const condition: Condition | undefined = state === undefined ? "first_message" : undefined;

  const isMediaOnly =
    ctx.input.body.length === 0 && ctx.input.media_urls !== undefined && ctx.input.media_urls.length > 0;
  if (isMediaOnly) return mediaOnlyFindings(condition);

  return [
    ...optOutFindings(ctx.input.body, condition),
    ...brandFindings(ctx.input, condition),
    ...optInFindings(ctx.input, condition),
  ];
}
