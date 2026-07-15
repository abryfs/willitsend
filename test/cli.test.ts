import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

// CLI contract (G7): exit 0 = pass/warn, 1 = block, 2 = needs_context,
// 3 = usage error. --strict promotes warn to exit 1. Output is a
// human-readable trace; --json emits the raw report.

function cli(args: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const code = runCli(args, (s) => lines.push(s));
  return { code, out: lines.join("\n") };
}

const COMPLIANT =
  "Acme: thanks for signing up for alerts. Reply STOP to unsubscribe.";

describe("exit codes", () => {
  it("clean message with known context exits 0", () => {
    const { code } = cli([COMPLIANT, "--first-message", "--brand", "Acme"]);
    expect(code).toBe(0);
  });

  it("blocking finding exits 1", () => {
    const { code, out } = cli(["Hello, see you at 2pm", "--first-message"]);
    expect(code).toBe(1);
    expect(out).toMatch(/block/i);
  });

  it("unknown first-message context exits 2 (needs context)", () => {
    const { code, out } = cli(["Hello, see you at 2pm"]);
    expect(code).toBe(2);
    expect(out).toMatch(/needs.context|unknown/i);
  });

  it("warn exits 0 normally, 1 under --strict", () => {
    const warny = "Grab a beer tonight! Reply STOP to unsubscribe.";
    expect(cli([warny, "--not-first"]).code).toBe(0);
    expect(cli([warny, "--not-first", "--strict"]).code).toBe(1);
  });

  it("no body is a usage error: exit 3 with help text", () => {
    const { code, out } = cli([]);
    expect(code).toBe(3);
    expect(out).toMatch(/usage/i);
  });

  it("unknown flag is a usage error", () => {
    expect(cli(["hi", "--bogus"]).code).toBe(3);
  });
});

describe("output", () => {
  it("human output shows verdict, segments, and finding citations", () => {
    const { out } = cli(["Hello, see you at 2pm \u{1F600}", "--first-message"]);
    expect(out).toMatch(/verdict/i);
    expect(out).toMatch(/segment/i);
    expect(out).toContain("https://docs.agentphone.ai");
  });

  it("--json emits the raw report", () => {
    const { out } = cli([COMPLIANT, "--first-message", "--brand", "Acme", "--json"]);
    const report = JSON.parse(out);
    expect(report.verdict).toBe("pass");
    expect(report.trace.segments.encoding).toBe("gsm7");
    expect(Array.isArray(report.findings)).toBe(true);
  });

  it("--to and --campaign feed through to the engine", () => {
    const { out } = cli([
      COMPLIANT,
      "--first-message",
      "--brand",
      "Acme",
      "--to",
      "+14155552671",
      "--campaign",
      "sole_proprietor",
      "--json",
    ]);
    const report = JSON.parse(out);
    expect(report.trace.destination.class).toBe("e164");
    expect(report.trace.quota.tmobile_daily_cap).toBe(1000);
  });

  it("never echoes the message body to output unless asked (privacy, G13)", () => {
    const { out } = cli(["SECRETBODYTOKEN see you at 2pm", "--not-first"]);
    expect(out).not.toContain("SECRETBODYTOKEN");
  });
});
