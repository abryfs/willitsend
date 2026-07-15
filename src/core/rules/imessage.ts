/**
 * iMessage-specific rules: invalid `send_style` values, carousel limits,
 * feature fallback when a send may land on SMS/MMS instead, and the
 * new-contact daily cap advisory.
 */

import { AGENTPHONE_MESSAGES, AGENTPHONE_RATE_LIMITS } from "../sources.js";
import { SEND_STYLES } from "../types.js";
import type { Condition, Finding } from "../types.js";
import type { RuleContext } from "./context.js";

const CAROUSEL_MAX = 20;
const NEW_CONTACT_DAILY_CAP = 50;

/** `send_style` must be one of the values the AgentPhone API accepts. */
export function invalidSendStyleFindings(ctx: RuleContext): Finding[] {
  const { send_style } = ctx.input;
  if (send_style === undefined) return [];
  if ((SEND_STYLES as readonly string[]).includes(send_style)) return [];
  return [
    {
      rule: "imessage.invalid-send-style",
      severity: "block",
      message: `"${send_style}" isn't a valid send_style. Valid values: ${SEND_STYLES.join(", ")}.`,
      source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
    },
  ];
}

/** iMessage carousels support at most 20 images. */
export function carouselCountFindings(ctx: RuleContext): Finding[] {
  const media = ctx.input.media_urls;
  if (media === undefined || media.length <= CAROUSEL_MAX) return [];
  return [
    {
      rule: "imessage.carousel-count",
      severity: "block",
      message: `iMessage carousels support at most ${CAROUSEL_MAX} images; this message has ${media.length}.`,
      source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
    },
  ];
}

function usesIMessageOnlyFeature(ctx: RuleContext): boolean {
  const { send_style, reply_to_message_id, media_urls } = ctx.input;
  if (send_style !== undefined) return true;
  if (reply_to_message_id !== undefined) return true;
  if (media_urls !== undefined && media_urls.length >= 2 && media_urls.length <= CAROUSEL_MAX) return true;
  return false;
}

/**
 * `send_style`, `reply_to_message_id`, and carousels are iMessage-only. On
 * a destination that could also deliver over SMS/MMS, these features are
 * silently dropped if the recipient can't take iMessage.
 */
export function featureFallbackFindings(ctx: RuleContext): Finding[] {
  if (!usesIMessageOnlyFeature(ctx)) return [];
  // Email/group destinations never fall back — they're iMessage-only.
  if (ctx.destination.class === "email" || ctx.destination.class === "group_id") return [];

  const caps = ctx.input.destination_capabilities;
  if (caps?.imessage === true) return [];

  const message =
    "This message uses an iMessage-only feature (send_style, reply_to_message_id, or a " +
    "carousel), but the destination may not support iMessage. If it falls back to SMS/MMS, " +
    "the feature is dropped silently.";

  if (caps?.imessage === false) {
    return [
      {
        rule: "imessage.feature-fallback",
        severity: "warn",
        message,
        source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
      },
    ];
  }

  return [
    {
      rule: "imessage.feature-fallback",
      severity: "warn",
      condition: "sms_fallback" satisfies Condition,
      message,
      source: { kind: "agentphone-docs", url: AGENTPHONE_MESSAGES },
    },
  ];
}

function channelCouldBeIMessage(ctx: RuleContext): boolean {
  const caps = ctx.input.destination_capabilities;
  if (caps?.imessage === true) return true;
  if (ctx.destination.class === "email" || ctx.destination.class === "group_id") return true;
  if (caps === undefined && ctx.destination.class === "e164") return true;
  return false;
}

/** Advisory: iMessage caps sends to brand-new contacts at 50/day. */
export function newContactCapFindings(ctx: RuleContext): Finding[] {
  const state = ctx.input.is_first_message_to_contact;
  if (state === false) return [];
  if (!channelCouldBeIMessage(ctx)) return [];

  const condition: Condition | undefined = state === undefined ? "first_message" : undefined;
  return [
    {
      rule: "imessage.new-contact-cap",
      severity: "info",
      ...(condition ? { condition } : {}),
      message:
        `iMessage caps sends to a brand-new contact at ${NEW_CONTACT_DAILY_CAP}/day for accounts ` +
        "without an established messaging history. If this contact is new, delivery may be capped.",
      source: { kind: "agentphone-docs", url: AGENTPHONE_RATE_LIMITS },
    },
  ];
}
