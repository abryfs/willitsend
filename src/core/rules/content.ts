/**
 * Advisory content rules, sourced from industry (not carrier-API) guidance.
 * These are all warn/info — never block — since detection here is a
 * conservative keyword/pattern heuristic, not a compliance requirement.
 *
 * Hate speech is deliberately NOT covered by a keyword rule: it can't be
 * detected reliably with word lists (context, reclaimed terms, and coded
 * language all defeat static keyword matching), so we don't pretend to.
 */

import { CTIA_GUIDELINES, TWILIO_US_SMS } from "../sources.js";
import type { Finding } from "../types.js";
import type { RuleContext } from "./context.js";

const SHORTENER_HOSTS = new Set(["bit.ly", "tinyurl.com", "goo.gl", "t.co", "ow.ly", "is.gd", "buff.ly"]);

const SHAFT_CATEGORIES: { name: string; keywords: readonly string[] }[] = [
  { name: "sex", keywords: ["porn", "xxx", "nude", "escort"] },
  { name: "alcohol", keywords: ["beer", "wine", "whiskey", "vodka", "booze"] },
  { name: "firearms", keywords: ["gun", "firearm", "ammo", "rifle", "pistol"] },
  { name: "tobacco", keywords: ["cigarette", "cigar", "vape", "nicotine", "tobacco"] },
];

// Simple character-class repetition — linear, no backtracking.
const WORD_RE = /[a-z0-9']+/gi;
const URL_RE = /https?:\/\/[^\s]+/g;

function lowerTokens(body: string): string[] {
  return body.toLowerCase().match(WORD_RE) ?? [];
}

/** Conservative SHAFT-adjacent keyword scan (sex/alcohol/firearms/tobacco). */
export function shaftFindings(ctx: RuleContext): Finding[] {
  const tokens = new Set(lowerTokens(ctx.input.body));
  const findings: Finding[] = [];

  for (const category of SHAFT_CATEGORIES) {
    const hits = category.keywords.filter((keyword) => tokens.has(keyword));
    if (hits.length === 0) continue;
    findings.push({
      rule: "content.shaft",
      severity: "warn",
      message: `Message mentions ${category.name}-related term(s): ${hits.join(", ")}. Some carriers filter or throttle messages referencing ${category.name} content.`,
      source: { kind: "ctia", url: CTIA_GUIDELINES },
    });
  }

  return findings;
}

/** Public URL shorteners obscure the destination and are widely filtered. */
export function urlShortenerFindings(ctx: RuleContext): Finding[] {
  const urls = ctx.input.body.match(URL_RE) ?? [];
  const findings: Finding[] = [];

  for (const raw of urls) {
    let host: string;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!SHORTENER_HOSTS.has(host)) continue;
    findings.push({
      rule: "content.url-shortener",
      severity: "warn",
      message: `Link uses a public URL shortener (${host}); carriers increasingly filter or flag shortened links in SMS/MMS.`,
      source: { kind: "twilio", url: TWILIO_US_SMS },
    });
  }

  return findings;
}

const HEURISTIC_SOURCE_URL = TWILIO_US_SMS;

/** Cheap spam-heuristics: shouty caps, "$$$", and "!!!"-style punctuation. */
export function spamPatternFindings(ctx: RuleContext): Finding[] {
  const body = ctx.input.body;
  const findings: Finding[] = [];

  const capsWords = (body.match(/[A-Za-z']+/g) ?? []).filter(
    (word) => word.length >= 5 && word === word.toUpperCase(),
  );
  if (capsWords.length >= 2) {
    findings.push({
      rule: "content.spam-patterns",
      severity: "info",
      message: `Message has multiple ALL-CAPS words (${capsWords.slice(0, 3).join(", ")}); this reads as spammy to carrier content filters.`,
      source: { kind: "heuristic", url: HEURISTIC_SOURCE_URL },
    });
  }

  if (body.includes("$$$")) {
    findings.push({
      rule: "content.spam-patterns",
      severity: "info",
      message: 'Message contains "$$$", a pattern commonly associated with spam and filtered by carriers.',
      source: { kind: "heuristic", url: HEURISTIC_SOURCE_URL },
    });
  }

  if (/!!!/.test(body)) {
    findings.push({
      rule: "content.spam-patterns",
      severity: "info",
      message: "Message has 3+ consecutive exclamation marks, a pattern commonly associated with spam.",
      source: { kind: "heuristic", url: HEURISTIC_SOURCE_URL },
    });
  }

  return findings;
}
