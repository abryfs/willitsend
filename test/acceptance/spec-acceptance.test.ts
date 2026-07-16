/**
 * Held-out acceptance suite for willitsend.
 *
 * Written independently of the unit suites, from the documented behavior
 * contract alone: the verdict model, the rule catalog and its sources, the
 * published GSM-7/UCS-2 rules (3GPP TS 23.038), the CLI exit-code contract,
 * and the MCP tool surface. Numeric expectations are hand-derived, with the
 * derivation shown above each non-obvious assertion. Deliberately redundant
 * with the unit suites: if the two ever disagree, trust this file's reading
 * of the documented contract and treat the divergence as a bug.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  CAMPAIGN_TYPES,
  MAX_BODY_LENGTH,
  PreflightInputError,
  SEND_STYLES,
  analyzeSegments,
  preflight,
} from "../../src/core/index.js";
import type { Finding, PreflightInput, PreflightReport, Verdict } from "../../src/core/index.js";
import { runCli } from "../../src/cli.js";
import { createServer } from "../../src/mcp/server.js";

// ---------------------------------------------------------------------------
// Helpers derived straight from the documented behavior contract.
// ---------------------------------------------------------------------------

/**
 * Verdict aggregation, encoded from the documented verdict model (not from the code):
 *   - "block"         : at least one unconditional block finding.
 *   - "needs_context" : a block-severity finding is conditional on unknown
 *                       context (carries `condition`), and no unconditional
 *                       block exists. ("An unknown flag can never yield a bare
 *                       pass or a fake block.")
 *   - "warn"          : warn finding(s), nothing blocking.
 *   - "pass"          : nothing above info.
 * needs_context is scoped to BLOCK-severity conditionals only; a
 * conditional warn still aggregates to "warn".
 */
function expectedVerdict(findings: Finding[]): Verdict {
  const unconditionalBlock = findings.some((f) => f.severity === "block" && f.condition === undefined);
  const conditionalBlock = findings.some((f) => f.severity === "block" && f.condition !== undefined);
  const warn = findings.some((f) => f.severity === "warn");
  if (unconditionalBlock) return "block";
  if (conditionalBlock) return "needs_context";
  if (warn) return "warn";
  return "pass";
}

function findingsMatching(report: PreflightReport, needle: RegExp): Finding[] {
  return report.findings.filter((f) => needle.test(f.rule) || needle.test(f.message));
}

function runCliCapture(argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = runCli(argv, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

async function connectMcp(opts?: Parameters<typeof createServer>[0]) {
  const server = createServer(opts ?? {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "acceptance", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

function textOf(result: any): string {
  const content = result?.content ?? [];
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Public enum / constant contracts.
// ---------------------------------------------------------------------------

describe("public constants", () => {
  it("SEND_STYLES is the exact 12-value iMessage enum", () => {
    expect([...SEND_STYLES]).toEqual([
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
    ]);
  });

  it("CAMPAIGN_TYPES is the six documented 10DLC tiers", () => {
    expect([...CAMPAIGN_TYPES]).toEqual([
      "sole_proprietor",
      "low_volume",
      "high_volume_low_trust",
      "high_volume_standard",
      "high_volume_high_trust",
      "high_volume_highest_trust",
    ]);
  });

  it("MAX_BODY_LENGTH is 10,000 (hard input cap)", () => {
    expect(MAX_BODY_LENGTH).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Segment math. Hand-derived per 3GPP TS 23.038.
// ---------------------------------------------------------------------------

describe("segment math", () => {
  it("160 GSM-7 septets fit one segment; 161 spills to two (153+8)", () => {
    // Single-segment GSM-7 capacity = 160 septets.
    const s160 = analyzeSegments("A".repeat(160));
    expect(s160.encoding).toBe("gsm7");
    expect(s160.units).toBe(160);
    expect(s160.segments).toBe(1);

    // 161 > 160 -> multipart; each part carries 153 septets (7 for the UDH).
    // 161 = 153 + 8 -> 2 segments, perSegment [153, 8].
    const s161 = analyzeSegments("A".repeat(161));
    expect(s161.encoding).toBe("gsm7");
    expect(s161.units).toBe(161);
    expect(s161.segments).toBe(2);
    expect(s161.perSegment).toEqual([153, 8]);
  });

  it("GSM extension chars cost 2 septets and stay GSM-7 (€)", () => {
    // '€' is in the GSM-7 extension table: encoded as ESC + char = 2 septets.
    // It does NOT force UCS-2.
    const s = analyzeSegments("€");
    expect(s.encoding).toBe("gsm7");
    expect(s.chars).toBe(1);
    expect(s.units).toBe(2);
    expect(s.segments).toBe(1);
    expect(s.extensionChars).toContain("€");
  });

  it("a single emoji flips the whole message to UCS-2", () => {
    // '😀' (U+1F600) is not GSM-7 representable -> UCS-2 for the entire body.
    // UCS-2 counts UTF-16 code units: "Hello " = 6, emoji = 2 (surrogate pair).
    const s = analyzeSegments("Hello 😀");
    expect(s.encoding).toBe("ucs2");
    expect(s.chars).toBe(7); // 6 code points + 1 emoji code point
    expect(s.units).toBe(8); // 6 + 2 UTF-16 units
    expect(s.segments).toBe(1); // 8 <= 70
    expect(s.nonGsmChars).toContain("😀");
  });

  it("a smart quote (U+2019) forces UCS-2", () => {
    // Curly apostrophe is not in GSM-7 -> UCS-2.
    const s = analyzeSegments("Don’t");
    expect(s.encoding).toBe("ucs2");
    expect(s.nonGsmChars).toContain("’");
  });

  it("placement rule: a 2-septet atom never straddles a boundary (extension chars)", () => {
    // Boundary-exact probe. Body = 151 'x' + '[' + 151 'x' + '['.
    // '[' is an extension char (2 septets); 'x' is 1 septet.
    // Total septets = 151 + 2 + 151 + 2 = 306 -> multipart (153/segment).
    // Pack seg1: 151 'x' (151) + '[' (2) = 153 exactly. seg2: 151 'x' + '[' = 153.
    // => 2 segments, perSegment [153, 153], no wasted septet here.
    const body = "x".repeat(151) + "[" + "x".repeat(151) + "[";
    const s = analyzeSegments(body);
    expect(s.encoding).toBe("gsm7");
    expect(s.chars).toBe(304); // 151 + 1 + 151 + 1
    expect(s.units).toBe(306);
    expect(s.segments).toBe(2);
    expect(s.perSegment).toEqual([153, 153]);
  });

  it("placement rule adds a segment when naive septet division would not", () => {
    // Body = 153 '[' extension chars. Each is 2 septets -> 306 naive septets.
    // Naive ceil(306/153) = 2. But a 2-septet atom cannot straddle a boundary:
    // each 153-septet segment holds floor(153/2)=76 ext chars = 152 septets,
    // wasting 1 septet. seg1 = 76 chars, seg2 = 76 chars, seg3 = 1 char.
    // => 3 segments (placement-aware), perSegment [152, 152, 2].
    const body = "[".repeat(153);
    const s = analyzeSegments(body);
    expect(s.encoding).toBe("gsm7");
    expect(s.chars).toBe(153);
    expect(s.units).toBe(306);
    expect(s.segments).toBe(3);
    expect(s.perSegment).toEqual([152, 152, 2]);
  });

  it("placement rule wastes a septet mid-message when an extension char won't fit", () => {
    // Body = 152 'x' + '[' + 10 'x'. Septets = 152 + 2 + 10 = 164 -> multipart.
    // seg1: 152 'x' = 152; next '[' needs 2 but only 1 slot remains -> moves to
    // seg2, seg1 finalized at 152 (1 septet wasted). seg2: '[' (2) + 10 'x' = 12.
    // => 2 segments, perSegment [152, 12].
    const body = "x".repeat(152) + "[" + "x".repeat(10);
    const s = analyzeSegments(body);
    expect(s.units).toBe(164);
    expect(s.segments).toBe(2);
    expect(s.perSegment).toEqual([152, 12]);
  });

  it("UCS-2 placement: a surrogate-pair emoji never straddles the 67-unit boundary", () => {
    // Body = 66 'a' + 😀 + 10 'a'. Emoji forces UCS-2 (1 unit each 'a', 2 units emoji).
    // Total units = 66 + 2 + 10 = 78 > 70 -> multipart (67 units/segment).
    // seg1: 66 'a' = 66; emoji needs 2 but only 1 slot remains -> moves to seg2.
    // seg1 = 66 (1 unit wasted). seg2: emoji (2) + 10 'a' = 12.
    // => 2 segments, perSegment [66, 12]. chars = 66 + 1 + 10 = 77.
    const body = "a".repeat(66) + "😀" + "a".repeat(10);
    const s = analyzeSegments(body);
    expect(s.encoding).toBe("ucs2");
    expect(s.chars).toBe(77);
    expect(s.units).toBe(78);
    expect(s.segments).toBe(2);
    expect(s.perSegment).toEqual([66, 12]);
  });

  it("preflight().trace.segments agrees with analyzeSegments()", () => {
    const body = "[".repeat(153);
    const report = preflight({ body, is_first_message_to_contact: false });
    expect(report.trace.segments).toEqual(analyzeSegments(body));
  });
});

// ---------------------------------------------------------------------------
// Verdict aggregation.
// ---------------------------------------------------------------------------

describe("verdict aggregation", () => {
  const cases: PreflightInput[] = [
    { body: "Hello there", is_first_message_to_contact: false },
    { body: "Hello there" }, // unknown first message
    { body: "Hello there", is_first_message_to_contact: true },
    {
      body: "Acme Alerts: you signed up for order updates. Reply STOP to unsubscribe.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    },
    { body: "FREE!!! WIN A $$$ PRIZE NOW!!! ACT FAST!!!", is_first_message_to_contact: false },
    { body: "Hi", to_number: "+15551234567", is_first_message_to_contact: false, send_style: "confetti" },
    { body: "Hi", to_number: "+15551234567", is_first_message_to_contact: false, destination_line_type: "voip" },
    { body: "Hi", recipients: ["+15551234567", "user@example.com"], is_first_message_to_contact: false },
    { body: "Hi", to_number: "user@example.com", is_first_message_to_contact: false },
    { body: "A".repeat(300), campaign_type: "sole_proprietor", is_first_message_to_contact: false },
    { body: "Hi", to_number: "not-a-real-destination", is_first_message_to_contact: false },
  ];

  it.each(cases.map((c, i) => [i, c] as const))(
    "report.verdict matches the documented aggregation for case %#",
    (_i, input) => {
      const report = preflight(input);
      expect(report.verdict).toBe(expectedVerdict(report.findings));
    },
  );

  it("unknown first-message context yields needs_context, never bare pass/block", () => {
    // is_first undefined => first-message rules report conditionally. Missing
    // opt-out is block-severity, condition "first_message" => needs_context.
    const report = preflight({ body: "Hello there", to_number: "+15551234567" });
    expect(report.verdict).toBe("needs_context");
    expect(report.verdict).not.toBe("pass");
    expect(report.verdict).not.toBe("block");
    expect(
      report.findings.some((f) => f.severity === "block" && f.condition === "first_message"),
    ).toBe(true);
  });

  it("is_first_message_to_contact:false silences first-message rules (bare pass)", () => {
    const report = preflight({ body: "Hello there", to_number: "+15551234567", is_first_message_to_contact: false });
    expect(report.verdict).toBe("pass");
    expect(report.findings.some((f) => f.condition === "first_message")).toBe(false);
    expect(findingsMatching(report, /opt-out|opt_out/i)).toHaveLength(0);
  });

  it("is_first_message_to_contact:true fires first-message rules unconditionally (block)", () => {
    // Clean body missing opt-out on a known-first message => unconditional block.
    const report = preflight({ body: "Hello there", to_number: "+15551234567", is_first_message_to_contact: true });
    expect(report.verdict).toBe("block");
    expect(
      report.findings.some((f) => f.severity === "block" && f.condition === undefined),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Brand, opt-out, opt-in detection.
// ---------------------------------------------------------------------------

describe("first-message content rules", () => {
  it("a fully compliant first message passes", () => {
    const report = preflight({
      body: "Acme Alerts: you signed up for order updates. Reply STOP to unsubscribe.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    });
    expect(report.verdict).toBe("pass");
  });

  it("brand rule never guesses: absent brand_name degrades to advisory (never blocks)", () => {
    // No brand_name provided. The brand rule may not assert a violation — it can
    // only advise "provide brand_name to verify". It must not be block-severity,
    // and it must not, by itself, block the verdict.
    const report = preflight({
      body: "Acme Alerts: you signed up. Reply STOP to unsubscribe.",
      is_first_message_to_contact: true,
    });
    const brand = findingsMatching(report, /brand/i);
    for (const f of brand) expect(f.severity).not.toBe("block");
    expect(report.verdict).not.toBe("block");
  });

  it("brand rule flags a real, verifiable mismatch when brand_name is given", () => {
    // brand_name present but absent from the body => a brand finding fires...
    const missing = preflight({
      body: "Alerts: you signed up. Reply STOP to unsubscribe.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    });
    expect(findingsMatching(missing, /brand/i).length).toBeGreaterThan(0);

    // ...and disappears once the brand name is actually present.
    const present = preflight({
      body: "Acme: you signed up. Reply STOP to unsubscribe.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    });
    expect(findingsMatching(present, /brand/i)).toHaveLength(0);
  });

  it("opt-out is satisfied only by instruction shape, not by the bare word 'stop'", () => {
    const base = "Acme Alerts: you signed up for updates. ";
    // Instruction-shaped opt-out -> rule satisfied, no opt-out finding.
    const compliant = preflight({
      body: base + "Reply STOP to unsubscribe.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    });
    expect(findingsMatching(compliant, /opt-out|opt_out|unsubscribe/i)).toHaveLength(0);

    // Prose containing "stop" without instruction shape does NOT satisfy it.
    const prose = preflight({
      body: base + "We never stop working for you.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    });
    expect(findingsMatching(prose, /opt-out|opt_out|unsubscribe/i).length).toBeGreaterThan(0);
    expect(prose.verdict).toBe("block"); // missing opt-out on a known-first message
  });

  it("opt-in is advisory-only — never block-severity", () => {
    // Brand + opt-out present, opt-in language absent. Any opt-in finding must be
    // advisory (never block), and must not, by itself, block the verdict.
    const report = preflight({
      body: "Acme Alerts: flash sale today. Reply STOP to unsubscribe.",
      brand_name: "Acme",
      is_first_message_to_contact: true,
    });
    for (const f of findingsMatching(report, /opt-in|opt_in|consent/i)) {
      expect(f.severity).not.toBe("block");
    }
    expect(["pass", "warn"]).toContain(report.verdict);
  });
});

// ---------------------------------------------------------------------------
// Destination classification.
// ---------------------------------------------------------------------------

describe("destination classification", () => {
  const classOf = (to: string) =>
    preflight({ body: "hi", to_number: to, is_first_message_to_contact: false }).trace.destination.class;

  it("classifies e164 / email / short_code / group_id / unknown", () => {
    expect(classOf("+15551234567")).toBe("e164");
    expect(classOf("user@example.com")).toBe("email");
    expect(classOf("12345")).toBe("short_code"); // 5 digits
    expect(classOf("123456")).toBe("short_code"); // 6 digits
    expect(classOf("grp_abc123")).toBe("group_id");
    expect(classOf("definitely not a number")).toBe("unknown");
  });

  it("email and grp_ destinations are iMessage-only paths", () => {
    const email = preflight({ body: "hi", to_number: "user@example.com", is_first_message_to_contact: false });
    expect(email.trace.channel_assumption).toBe("imessage");

    const group = preflight({ body: "hi", to_number: "grp_abc123", is_first_message_to_contact: false });
    expect(group.trace.channel_assumption).toBe("imessage");
  });

  it("a bare e164 with no capabilities is not assumed to be iMessage", () => {
    const e164 = preflight({ body: "hi", to_number: "+15551234567", is_first_message_to_contact: false });
    expect(e164.trace.channel_assumption).not.toBe("imessage");
  });

  it("send_style is validated against the 12-value enum", () => {
    // Use an iMessage destination so send_style is relevant. A valid style
    // produces no invalid-style finding; an off-enum value does.
    const valid = preflight({
      body: "hi",
      to_number: "user@example.com",
      send_style: "confetti",
      is_first_message_to_contact: false,
    });
    expect(findingsMatching(valid, /style/i).filter((f) => /invalid|unknown|not/i.test(f.message))).toHaveLength(0);

    const invalid = preflight({
      body: "hi",
      to_number: "user@example.com",
      send_style: "sparkleburst",
      is_first_message_to_contact: false,
    });
    expect(findingsMatching(invalid, /style/i).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// VoIP (no guessing) + quota illustration (static math).
// ---------------------------------------------------------------------------

describe("VoIP detection and quota illustration", () => {
  it("never asserts VoIP without destination_line_type", () => {
    const report = preflight({ body: "hi", to_number: "+15551234567", is_first_message_to_contact: false });
    // Any voip-related finding may only be informational (requires-context),
    // never a warn/block assertion, when line type was not provided.
    for (const f of findingsMatching(report, /voip/i)) expect(f.severity).toBe("info");
  });

  it("fires a voip finding only when destination_line_type says so", () => {
    const voip = preflight({
      body: "hi",
      to_number: "+15551234567",
      destination_line_type: "voip",
      is_first_message_to_contact: false,
    });
    expect(findingsMatching(voip, /voip/i).length).toBeGreaterThan(0);

    const mobile = preflight({
      body: "hi",
      to_number: "+15551234567",
      destination_line_type: "mobile",
      is_first_message_to_contact: false,
    });
    expect(findingsMatching(mobile, /voip/i)).toHaveLength(0);
  });

  it("quota illustration is static math from the six published caps", () => {
    // Body = 300 GSM-7 septets -> 2 segments (ceil(300/153)=2).
    // high_volume_high_trust T-Mobile cap = 40,000. Estimated total = 40,000 x 3
    // = 120,000. Messages/day = floor(120,000 / 2) = 60,000.
    const report = preflight({
      body: "A".repeat(300),
      campaign_type: "high_volume_high_trust",
      is_first_message_to_contact: false,
    });
    const q = report.trace.quota;
    expect(q).toBeDefined();
    expect(q!.campaign_type).toBe("high_volume_high_trust");
    expect(report.trace.segments.segments).toBe(2);
    expect(q!.segments_per_message).toBe(2);
    expect(q!.tmobile_daily_cap).toBe(40_000);
    expect(q!.estimated_total_daily_cap).toBe(120_000);
    expect(q!.messages_per_day_estimate).toBe(60_000);
  });

  it("maps each campaign tier to its published T-Mobile cap", () => {
    // Published T-Mobile caps: 1000 / 2000 / 2000 / 10000 / 40000 / 200000.
    const caps: Record<string, number> = {
      sole_proprietor: 1_000,
      low_volume: 2_000,
      high_volume_low_trust: 2_000,
      high_volume_standard: 10_000,
      high_volume_high_trust: 40_000,
      high_volume_highest_trust: 200_000,
    };
    for (const [tier, cap] of Object.entries(caps)) {
      const report = preflight({
        body: "hi", // single segment
        campaign_type: tier as any,
        is_first_message_to_contact: false,
      });
      const q = report.trace.quota!;
      expect(q.tmobile_daily_cap).toBe(cap);
      expect(q.estimated_total_daily_cap).toBe(cap * 3);
      // "hi" is 1 segment -> messages/day == estimated total.
      expect(q.segments_per_message).toBe(1);
      expect(q.messages_per_day_estimate).toBe(cap * 3);
    }
  });

  it("omits quota when no campaign_type is given", () => {
    const report = preflight({ body: "hi", is_first_message_to_contact: false });
    expect(report.trace.quota).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Untrusted-input defense.
// ---------------------------------------------------------------------------

describe("input defense", () => {
  it("body over 10,000 chars is a PreflightInputError; exactly 10,000 is accepted", () => {
    expect(() => preflight({ body: "a".repeat(10_001) })).toThrow(PreflightInputError);
    expect(() => preflight({ body: "a".repeat(10_000), is_first_message_to_contact: false })).not.toThrow();
  });

  it("empty body without media is a usage error; empty body with media is allowed", () => {
    expect(() => preflight({ body: "" })).toThrow(PreflightInputError);
    expect(() =>
      preflight({ body: "", media_urls: ["https://example.com/a.jpg"], is_first_message_to_contact: false }),
    ).not.toThrow();
  });

  it("adversarial input completes quickly (linear-time scans)", () => {
    const nasty = "!".repeat(10_000);
    const start = Date.now();
    preflight({ body: nasty, is_first_message_to_contact: false });
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// CLI contract.
// ---------------------------------------------------------------------------

describe("CLI contract", () => {
  it("exit 0 for pass", () => {
    expect(runCliCapture(["Hello there", "--not-first"]).code).toBe(0);
  });

  it("exit 1 for block", () => {
    expect(runCliCapture(["Hello there", "--first-message"]).code).toBe(1);
  });

  it("exit 2 for needs_context", () => {
    expect(runCliCapture(["Hello there"]).code).toBe(2);
  });

  it("exit 3 for usage errors", () => {
    expect(runCliCapture([]).code).toBe(3); // no message
    expect(runCliCapture(["--bogusflag"]).code).toBe(3); // unknown flag
    expect(runCliCapture(["a".repeat(10_001)]).code).toBe(3); // over the input cap
  });

  it("--strict promotes a warn to exit 1", () => {
    // A public URL-shortener link is a warn-severity advisory that never
    // blocks. As a plain content rule it fires from the body alone, so it is
    // reachable through the CLI. Without --strict a warn exits 0; --strict
    // promotes it to exit 1. (An earlier draft used a spam-pattern body,
    // but the spam-patterns rule is info-severity — advisory findings that
    // "never block" advisories may be info-severity, so that body stays a pass; the
    // URL-shortener rule is the warn-tier advisory this clause needs.)
    const body = "Check this deal http://bit.ly/xy now";
    expect(runCliCapture([body, "--not-first"]).code).toBe(0);
    expect(runCliCapture([body, "--not-first", "--strict"]).code).toBe(1);
  });

  it("--json round-trips a full report", () => {
    const { out } = runCliCapture(["Hello there", "--not-first", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("verdict");
    expect(parsed).toHaveProperty("findings");
    expect(parsed).toHaveProperty("trace");
    expect(parsed.verdict).toBe(preflight({ body: "Hello there", is_first_message_to_contact: false }).verdict);
  });
});

// ---------------------------------------------------------------------------
// No message body echoed back.
// ---------------------------------------------------------------------------

describe("no body echo", () => {
  const token = "zqxjkvbwpmqwer"; // distinctive, clean, produces no findings

  it("CLI human output does not echo the message body", () => {
    const { out } = runCliCapture([`${token} normal update`, "--not-first"]);
    expect(out).not.toContain(token);
  });

  it("MCP text content does not echo the message body", async () => {
    const { client } = await connectMcp();
    const result: any = await client.callTool({
      name: "preflight_message",
      arguments: { body: `${token} normal update` },
    });
    expect(textOf(result)).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// MCP server surface.
// ---------------------------------------------------------------------------

describe("MCP server", () => {
  it("exposes a single read-only preflight_message tool", async () => {
    const { client } = await connectMcp();
    const { tools } = await client.listTools();
    const tool = tools.find((t: any) => t.name === "preflight_message");
    expect(tool).toBeDefined();
    // Pre-send analysis, sends nothing -> read-only annotated.
    expect((tool as any).annotations?.readOnlyHint).toBe(true);
    // Input schema must accept a message body.
    expect((tool as any).inputSchema?.properties).toHaveProperty("body");
  });

  it("works with zero configuration (no API key)", async () => {
    const { client } = await connectMcp(); // no apiKey
    const result: any = await client.callTool({
      name: "preflight_message",
      arguments: { body: "Hello there", is_first_message_to_contact: false },
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });

  it("degrades gracefully when the capabilities lookup fails", async () => {
    // apiKey set + bare to_number triggers the enrichment fetch; a throwing
    // fetchImpl must NOT fail the tool call. The preflight proceeds pure.
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { client } = await connectMcp({ apiKey: "test-key", fetchImpl: failingFetch });

    const { tools } = await client.listTools();
    const props = (tools.find((t: any) => t.name === "preflight_message") as any).inputSchema?.properties ?? {};
    const destKey = ["to_number", "to", "toNumber"].find((k) => k in props) ?? "to_number";

    const result: any = await client.callTool({
      name: "preflight_message",
      arguments: { body: "Hello there", [destKey]: "+15551234567" },
    });
    // Enrichment failure can never fail the preflight.
    expect(result.isError).not.toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-recipient handling.
// ---------------------------------------------------------------------------

describe("multi-recipient handling", () => {
  it("classifies each recipient of a group send", () => {
    const report = preflight({
      body: "hi team",
      recipients: ["+15551234567", "user@example.com"],
      is_first_message_to_contact: false,
    });
    expect(report.trace.recipients).toBeDefined();
    expect(report.trace.recipients!.map((r) => r.class)).toEqual(["e164", "email"]);
    // 2+ recipients => iMessage group path.
    expect(report.trace.channel_assumption).toBe("imessage");
  });

  it("rejects to_number and recipients supplied together", () => {
    expect(() =>
      preflight({
        body: "hi",
        to_number: "+15551234567",
        recipients: ["+15551234567", "+15559876543"],
        is_first_message_to_contact: false,
      }),
    ).toThrow(PreflightInputError);
  });
});
