/**
 * Citation URLs for finding sources. Kept in one place so rule modules
 * never hand-roll a URL and so a docs move only needs one edit.
 */

export const AGENTPHONE_RATE_LIMITS =
  "https://docs.agentphone.ai/documentation/reference/messaging-rate-limits";
export const AGENTPHONE_MESSAGES = "https://docs.agentphone.ai/documentation/guides/messages";
export const AGENTPHONE_SEND_API =
  "https://docs.agentphone.ai/api-reference/messages/send-message-v-1-messages-post";
/** CTIA Messaging Principles and Best Practices (May 2023) — the PDF itself,
 * since that is where the cited guidance actually lives. */
export const CTIA_MPBP_PDF =
  "https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf";
export const CTIA_GUIDELINES =
  "https://www.ctia.org/the-wireless-industry/industry-commitments/messaging-interoperability-sms-mms";
export const TWILIO_US_SMS = "https://www.twilio.com/en-us/guidelines/us/sms";

// Section-anchored deep links (anchor ids verified against the rendered pages).
export const AGENTPHONE_FIRST_MESSAGE = `${AGENTPHONE_RATE_LIMITS}#first-message-requirements`;
export const AGENTPHONE_DELIVERY = `${AGENTPHONE_RATE_LIMITS}#delivery-and-reliability`;
export const AGENTPHONE_DAILY_LIMITS = `${AGENTPHONE_RATE_LIMITS}#daily-message-limits`;
export const AGENTPHONE_IMESSAGE_LIMITS = `${AGENTPHONE_RATE_LIMITS}#imessage`;
export const AGENTPHONE_SEND_EFFECTS = `${AGENTPHONE_MESSAGES}#send-effects`;
export const AGENTPHONE_IMESSAGE_GUIDE = `${AGENTPHONE_MESSAGES}#imessage`;
export const AGENTPHONE_CAROUSEL = `${AGENTPHONE_SEND_API}#carousel--multi-image-imessage`;
