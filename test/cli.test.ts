import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isCliEntry, runCli } from "../src/cli.js";

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

  it("unknown flag is a usage error that names the offender", () => {
    const { code, out } = cli(["hi", "--bogus"]);
    expect(code).toBe(3);
    expect(out).toContain("--bogus");
  });

  it("invalid campaign tier is named in the error", () => {
    const { out } = cli(["hi", "--campaign", "bogus"]);
    expect(out).toContain("bogus");
    expect(out).toMatch(/usage/i);
  });

  it("--version prints the version and exits 0", () => {
    const { code, out } = cli(["--version"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^willitsend \d+\.\d+\.\d+$/);
  });

  it("value flags never swallow the -- terminator", () => {
    const brand = cli(["--brand", "--", "hello world"]);
    expect(brand.code).toBe(3);
    expect(brand.out).toContain("--brand needs a value");
    expect(cli(["--campaign", "--", "hello"]).code).toBe(3);
  });

  it("a standalone -- ends option parsing so dash-leading bodies lint", () => {
    const { code, out } = cli(["--not-first", "--", "--50% off everything today"]);
    expect(code).toBe(0);
    expect(out).toMatch(/verdict/i);
    // flags after -- are body text, not options
    expect(cli(["--", "--help"]).code).not.toBe(0);
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

describe("entry-point detection (npm bin shims are symlinks)", () => {
  it("recognizes invocation through a symlinked bin path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wis-"));
    const real = join(dir, "cli.js");
    writeFileSync(real, "// stub");
    const link = join(dir, "bin-shim");
    symlinkSync(real, link);
    const moduleUrl = pathToFileURL(realpathSync(real)).href;
    expect(isCliEntry(link, moduleUrl)).toBe(true);
    expect(isCliEntry(real, moduleUrl)).toBe(true);
    expect(isCliEntry(join(dir, "missing"), moduleUrl)).toBe(false);
    expect(isCliEntry(undefined, moduleUrl)).toBe(false);
  });
});
