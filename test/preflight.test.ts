import { describe, expect, it } from "vitest";
import { preflight } from "../src/core/preflight.js";
import { PreflightInputError } from "../src/core/types.js";
import type { Finding, PreflightInput } from "../src/core/types.js";

// Behavioral contract for the rules engine. Rule severities and conditions
// follow the docs they encode: first-message requirements are block-level
// because AgentPhone's docs say non-compliant first messages "may be
// silently filtered by carriers" with no API error; industry-sourced rules
// are advisory (warn/info) and must never block.

const COMPLIANT_FIRST =
  "Acme Dental: thanks for signing up for appointment reminders. " +
  "Your cleaning is tomorrow at 2pm. Reply STOP to unsubscribe.";

function run(overrides: Partial<PreflightInput>): ReturnType<typeof preflight> {
  return preflight({ body: COMPLIANT_FIRST, ...overrides });
}

function byRule(findings: Finding[], rule: string): Finding[] {
  return findings.filter((f) => f.rule === rule);
}

describe("verdict aggregation", () => {
  it("clean compliant first message passes", () => {
    const r = run({
      is_first_message_to_contact: true,
      brand_name: "Acme Dental",
      to_number: "+14155552671",
    });
    expect(r.verdict).toBe("pass");
    expect(r.findings.filter((f) => f.severity !== "info")).toEqual([]);
  });

  it("confirmed first message missing opt-out blocks", () => {
    const r = run({
      body: "Acme Dental: thanks for signing up. See you tomorrow at 2pm.",
      is_first_message_to_contact: true,
      brand_name: "Acme Dental",
    });
    expect(r.verdict).toBe("block");
    const f = byRule(r.findings, "first-message.opt-out");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.condition).toBeUndefined();
    expect(f[0]!.fix).toContain("STOP");
  });

  it("UNKNOWN first-message state yields needs_context, never a bare pass or block", () => {
    const r = run({
      body: "Hey, quick reminder about tomorrow at 2pm.",
    });
    expect(r.verdict).toBe("needs_context");
    const f = byRule(r.findings, "first-message.opt-out");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.condition).toBe("first_message");
  });

  it("explicitly NOT a first message: first-message rules stay silent", () => {
    const r = run({
      body: "Hey, quick reminder about tomorrow at 2pm.",
      is_first_message_to_contact: false,
    });
    expect(byRule(r.findings, "first-message.opt-out")).toEqual([]);
    expect(byRule(r.findings, "first-message.brand")).toEqual([]);
    expect(byRule(r.findings, "first-message.opt-in")).toEqual([]);
    expect(r.verdict).toBe("pass");
  });

  it("warn findings without blocks yield warn", () => {
    const r = run({
      body: "Grab a beer with us tonight! Reply STOP to unsubscribe.",
      is_first_message_to_contact: false,
    });
    expect(r.verdict).toBe("warn");
  });
});

describe("first-message.opt-out detection (G4: conservative, instruction-shaped)", () => {
  const satisfied = [
    "Reply STOP to unsubscribe.",
    "Text STOP to opt out",
    "reply stop to cancel anytime",
    "Reply UNSUBSCRIBE to end these messages",
    "Send QUIT to stop receiving reminders",
  ];
  const notSatisfied = [
    "Our services never stop improving",
    "Please stop by our store this weekend",
    "The bus stops running at midnight",
    "We will never quit on you",
  ];

  it.each(satisfied)("%j satisfies the opt-out requirement", (tail) => {
    const r = preflight({
      body: `Acme: you signed up for alerts. ${tail}`,
      is_first_message_to_contact: true,
      brand_name: "Acme",
    });
    expect(byRule(r.findings, "first-message.opt-out")).toEqual([]);
  });

  it.each(notSatisfied)("%j does NOT satisfy it (no instruction context)", (body) => {
    const r = preflight({
      body: `Acme: you signed up for alerts. ${body}`,
      is_first_message_to_contact: true,
      brand_name: "Acme",
    });
    expect(byRule(r.findings, "first-message.opt-out")).toHaveLength(1);
  });

  it("opt-out rule is English-only and says so", () => {
    const r = preflight({ body: "x", is_first_message_to_contact: true });
    const f = byRule(r.findings, "first-message.opt-out")[0]!;
    expect(f.locale).toBe("en");
  });

  it("cites AgentPhone's rate-limits docs", () => {
    const r = preflight({ body: "x", is_first_message_to_contact: true });
    const f = byRule(r.findings, "first-message.opt-out")[0]!;
    expect(f.source.kind).toBe("agentphone-docs");
    expect(f.source.url).toContain("docs.agentphone.ai");
    expect(f.source.url).toContain("rate-limits");
  });
});

describe("first-message.brand (G4: only ever checks a provided brand_name)", () => {
  it("brand present (case/whitespace-insensitive) passes", () => {
    const r = preflight({
      body: "ACME  DENTAL: you signed up. Reply STOP to unsubscribe.",
      is_first_message_to_contact: true,
      brand_name: "Acme Dental",
    });
    expect(byRule(r.findings, "first-message.brand")).toEqual([]);
  });

  it("brand absent from body blocks", () => {
    const r = preflight({
      body: "You signed up for reminders. Reply STOP to unsubscribe.",
      is_first_message_to_contact: true,
      brand_name: "Acme Dental",
    });
    const f = byRule(r.findings, "first-message.brand");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("block");
  });

  it("no brand_name given: advisory info asking for it, never a guess", () => {
    const r = preflight({
      body: "You signed up for reminders. Reply STOP to unsubscribe.",
      is_first_message_to_contact: true,
    });
    const f = byRule(r.findings, "first-message.brand");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.message).toContain("brand_name");
  });
});

describe("first-message.opt-in (lowest-confidence, warn only)", () => {
  it("opt-in acknowledgment present passes", () => {
    for (const phrase of [
      "thanks for signing up",
      "you subscribed to",
      "you opted in to",
      "you requested",
      "thanks for joining",
    ]) {
      const r = preflight({
        body: `Acme: ${phrase} our alerts. Reply STOP to unsubscribe.`,
        is_first_message_to_contact: true,
        brand_name: "Acme",
      });
      expect(byRule(r.findings, "first-message.opt-in")).toEqual([]);
    }
  });

  it("missing opt-in language warns (never blocks — detection is fuzzy)", () => {
    const r = preflight({
      body: "Acme: your appointment is at 2pm. Reply STOP to unsubscribe.",
      is_first_message_to_contact: true,
      brand_name: "Acme",
    });
    const f = byRule(r.findings, "first-message.opt-in");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
  });

  it("never claims to verify consent itself", () => {
    const r = preflight({
      body: "Acme: appointment at 2pm. Reply STOP to unsubscribe.",
      is_first_message_to_contact: true,
    });
    const f = byRule(r.findings, "first-message.opt-in")[0]!;
    expect(f.message.toLowerCase()).toContain("language");
  });
});

describe("media-only first messages", () => {
  it("empty body with media on a first message warns (compliance text cannot ride in an image)", () => {
    const r = preflight({
      body: "",
      media_urls: ["https://example.com/a.jpg"],
      is_first_message_to_contact: true,
    });
    const f = byRule(r.findings, "first-message.media-only");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    // the text-based first-message rules should not also pile on
    expect(byRule(r.findings, "first-message.opt-out")).toEqual([]);
  });
});

describe("destination classification", () => {
  const cases: [string, string][] = [
    ["+14155552671", "e164"],
    ["person@example.com", "email"],
    ["86753", "short_code"],
    ["312555", "short_code"],
    ["grp_abc123", "group_id"],
    ["not a destination", "unknown"],
  ];
  it.each(cases)("%j -> %s", (raw, cls) => {
    const r = preflight({ body: "hi", to_number: raw, is_first_message_to_contact: false });
    expect(r.trace.destination.class).toBe(cls);
  });

  it("unknown destination format blocks", () => {
    const r = preflight({
      body: "hi",
      to_number: "not a destination",
      is_first_message_to_contact: false,
    });
    expect(r.verdict).toBe("block");
    expect(byRule(r.findings, "destination.invalid")).toHaveLength(1);
  });

  it("no destination at all is fine (content-only lint)", () => {
    const r = preflight({ body: "hi", is_first_message_to_contact: false });
    expect(r.trace.destination.class).toBe("unknown");
    expect(byRule(r.findings, "destination.invalid")).toEqual([]);
  });
});

describe("channel assumption + iMessage feature fallback", () => {
  it("capabilities.imessage=true: channel imessage, no fallback warning", () => {
    const r = preflight({
      body: "hi",
      to_number: "+14155552671",
      send_style: "confetti",
      destination_capabilities: { imessage: true, sms: true },
      is_first_message_to_contact: false,
    });
    expect(r.trace.channel_assumption).toBe("imessage");
    expect(byRule(r.findings, "imessage.feature-fallback")).toEqual([]);
  });

  it("capabilities.imessage=false with send_style: unconditional warn (feature WILL drop)", () => {
    const r = preflight({
      body: "hi",
      to_number: "+14155552671",
      send_style: "confetti",
      destination_capabilities: { imessage: false, sms: true },
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "imessage.feature-fallback");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.condition).toBeUndefined();
  });

  it("capabilities unknown with iMessage-only features: conditional warn", () => {
    const r = preflight({
      body: "hi",
      to_number: "+14155552671",
      reply_to_message_id: "msg_123",
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "imessage.feature-fallback");
    expect(f).toHaveLength(1);
    expect(f[0]!.condition).toBe("sms_fallback");
  });

  it("no iMessage-only features used: no fallback finding at all", () => {
    const r = preflight({
      body: "hi",
      to_number: "+14155552671",
      is_first_message_to_contact: false,
    });
    expect(byRule(r.findings, "imessage.feature-fallback")).toEqual([]);
  });

  it("email destination is iMessage-only: no fallback risk, channel imessage", () => {
    const r = preflight({
      body: "hi",
      to_number: "person@example.com",
      send_style: "lasers",
      is_first_message_to_contact: false,
    });
    expect(r.trace.channel_assumption).toBe("imessage");
    expect(byRule(r.findings, "imessage.feature-fallback")).toEqual([]);
  });

  it("invalid send_style blocks and names the valid values", () => {
    const r = preflight({
      body: "hi",
      send_style: "party",
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "imessage.invalid-send-style");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("block");
    expect(f[0]!.message).toContain("confetti");
  });

  it("carousel over 20 media_urls blocks", () => {
    const r = preflight({
      body: "",
      media_urls: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}.jpg`),
      is_first_message_to_contact: false,
    });
    expect(byRule(r.findings, "imessage.carousel-count")).toHaveLength(1);
    expect(r.verdict).toBe("block");
  });

  it("media on the SMS path assumes mms", () => {
    const r = preflight({
      body: "pic attached",
      to_number: "+14155552671",
      media_urls: ["https://example.com/a.jpg"],
      destination_capabilities: { imessage: false, sms: true },
      is_first_message_to_contact: false,
    });
    expect(r.trace.channel_assumption).toBe("mms");
  });
});

describe("group sends (G15)", () => {
  it("2+ recipients = iMessage group; per-recipient classes in trace", () => {
    const r = preflight({
      body: "hi all",
      recipients: ["+14155552671", "person@example.com"],
      is_first_message_to_contact: false,
    });
    expect(r.trace.channel_assumption).toBe("imessage");
    expect(r.trace.recipients).toHaveLength(2);
    expect(r.trace.recipients![0]!.class).toBe("e164");
    expect(r.trace.recipients![1]!.class).toBe("email");
  });

  it("an invalid recipient is reported per-recipient", () => {
    const r = preflight({
      body: "hi all",
      recipients: ["+14155552671", "garbage!!"],
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "destination.invalid");
    expect(f).toHaveLength(1);
    expect(f[0]!.recipient).toBe("garbage!!");
  });

  it("to_number and recipients together is a usage error", () => {
    expect(() =>
      preflight({ body: "hi", to_number: "+14155552671", recipients: ["+14155552671", "+14155552672"] }),
    ).toThrow(PreflightInputError);
  });
});

describe("voip destination (D9: never guessed)", () => {
  it("known voip line type warns with docs citation", () => {
    const r = preflight({
      body: "hi",
      to_number: "+14155552671",
      destination_line_type: "voip",
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "destination.voip");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.source.kind).toBe("agentphone-docs");
  });

  it("unknown line type: no finding, just a trace note", () => {
    const r = preflight({
      body: "hi",
      to_number: "+14155552671",
      is_first_message_to_contact: false,
    });
    expect(byRule(r.findings, "destination.voip")).toEqual([]);
    expect(r.trace.notes.join(" ")).toMatch(/line type/i);
  });
});

describe("segments in the trace + unicode blowup", () => {
  it("trace carries full segment info", () => {
    const r = preflight({ body: "hello", is_first_message_to_contact: false });
    expect(r.trace.segments.encoding).toBe("gsm7");
    expect(r.trace.segments.units).toBe(5);
    expect(r.trace.segments.segments).toBe(1);
  });

  it("one emoji doubling the segment count warns and names the culprit", () => {
    const body = "a".repeat(100) + "\u{1F600}"; // GSM would be 1 segment; UCS-2 = 102 units = 2
    const r = preflight({ body, is_first_message_to_contact: false });
    const f = byRule(r.findings, "segments.unicode-blowup");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(r.trace.segments.segments).toBe(2);
  });

  it("short unicode message that stays 1 segment does not warn", () => {
    const r = preflight({ body: "see you soon \u{1F600}", is_first_message_to_contact: false });
    expect(byRule(r.findings, "segments.unicode-blowup")).toEqual([]);
  });
});

describe("quota illustration (G2: AgentPhone's published table only)", () => {
  it("present when campaign_type given; math is floor(estimated_total / segments)", () => {
    const body = "a".repeat(200); // 2 segments
    const r = preflight({ body, campaign_type: "sole_proprietor", is_first_message_to_contact: false });
    const q = r.trace.quota!;
    expect(q.segments_per_message).toBe(2);
    expect(q.tmobile_daily_cap).toBe(1000);
    expect(q.estimated_total_daily_cap).toBe(3000);
    expect(q.messages_per_day_estimate).toBe(1500);
    expect(q.note.toLowerCase()).toContain("estimate");
  });

  it("highest trust tier uses 200k cap", () => {
    const r = preflight({
      body: "hi",
      campaign_type: "high_volume_highest_trust",
      is_first_message_to_contact: false,
    });
    expect(r.trace.quota!.tmobile_daily_cap).toBe(200_000);
    expect(r.trace.quota!.estimated_total_daily_cap).toBe(600_000);
  });

  it("absent without campaign_type", () => {
    const r = preflight({ body: "hi", is_first_message_to_contact: false });
    expect(r.trace.quota).toBeUndefined();
  });
});

describe("industry-sourced rules are advisory only (can NEVER block)", () => {
  it("SHAFT-adjacent content warns with CTIA citation", () => {
    const r = preflight({
      body: "Half-price whiskey and cigars this Friday. Reply STOP to unsubscribe.",
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "content.shaft");
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.source.kind).toBe("ctia");
    expect(r.verdict).toBe("warn");
  });

  it("public URL shortener warns with Twilio citation", () => {
    const r = preflight({
      body: "Track your order: https://bit.ly/3xYz",
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "content.url-shortener");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.source.kind).toBe("twilio");
  });

  it("full-domain links do not trigger the shortener rule", () => {
    const r = preflight({
      body: "Track your order: https://shop.example.com/orders/123",
      is_first_message_to_contact: false,
    });
    expect(byRule(r.findings, "content.url-shortener")).toEqual([]);
  });

  it("spam patterns are info-level heuristics", () => {
    const r = preflight({
      body: "WINNER WINNER!!! Claim your PRIZE $$$ NOW",
      is_first_message_to_contact: false,
    });
    const f = byRule(r.findings, "content.spam-patterns");
    expect(f.length).toBeGreaterThanOrEqual(1);
    for (const finding of f) {
      expect(finding.severity).toBe("info");
      expect(finding.source.kind).toBe("heuristic");
    }
  });

  it("a single caps acronym is not spam", () => {
    const r = preflight({
      body: "Download the PDF from HTTPS today",
      is_first_message_to_contact: false,
    });
    expect(byRule(r.findings, "content.spam-patterns")).toEqual([]);
  });

  it("no industry rule ever emits block severity", () => {
    const nasty =
      "FREE VODKA AND GUNS $$$ https://bit.ly/x WINNER WINNER CLICK NOW!!! " +
      "cigarettes vape casino";
    const r = preflight({ body: nasty, is_first_message_to_contact: false });
    for (const f of r.findings) {
      if (f.source.kind === "ctia" || f.source.kind === "twilio" || f.source.kind === "heuristic") {
        expect(f.severity).not.toBe("block");
      }
    }
  });
});

describe("input validation (G5)", () => {
  it("body over 10k chars is a usage error, not a finding", () => {
    expect(() => preflight({ body: "a".repeat(10_001) })).toThrow(PreflightInputError);
  });

  it("empty body with no media is a usage error", () => {
    expect(() => preflight({ body: "" })).toThrow(PreflightInputError);
  });

  it("adversarial input completes without hanging", () => {
    // classic ReDoS shapes: long runs of repeated groups + near-miss suffix
    const bodies = [
      "a".repeat(9_999) + "!",
      ("ab" as string).repeat(4_000) + "!!!!!!!",
      "STOP ".repeat(1_900),
      ("https://bit.ly/" + "x".repeat(50) + " ").repeat(100),
    ];
    const start = performance.now();
    for (const body of bodies) preflight({ body, is_first_message_to_contact: false });
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("iMessage new-contact cap note (G8)", () => {
  it("first message that may ride iMessage gets the 50/day info note", () => {
    const r = preflight({
      body: COMPLIANT_FIRST,
      to_number: "+14155552671",
      brand_name: "Acme Dental",
      is_first_message_to_contact: true,
      destination_capabilities: { imessage: true, sms: true },
    });
    const f = byRule(r.findings, "imessage.new-contact-cap");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.message).toContain("50");
  });

  it("not emitted for non-first messages", () => {
    const r = preflight({
      body: "hi again",
      to_number: "+14155552671",
      is_first_message_to_contact: false,
      destination_capabilities: { imessage: true, sms: true },
    });
    expect(byRule(r.findings, "imessage.new-contact-cap")).toEqual([]);
  });
});

describe("report shape", () => {
  it("every finding carries rule, severity, message, and a sourced https url", () => {
    const r = preflight({
      body: "FREE BEER $$$ https://bit.ly/x",
      send_style: "bogus",
      is_first_message_to_contact: true,
    });
    expect(r.findings.length).toBeGreaterThan(3);
    for (const f of r.findings) {
      expect(f.rule).toMatch(/^[a-z-]+\.[a-z-]+$/);
      expect(["block", "warn", "info"]).toContain(f.severity);
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.source.url).toMatch(/^https:\/\//);
    }
  });

  it("findings are ordered most severe first", () => {
    const r = preflight({
      body: "FREE BEER $$$ https://bit.ly/x",
      send_style: "bogus",
      is_first_message_to_contact: true,
    });
    const order = { block: 0, warn: 1, info: 2 } as const;
    const ranks = r.findings.map((f) => order[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});
