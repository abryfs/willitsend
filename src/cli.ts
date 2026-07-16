#!/usr/bin/env node
/**
 * `willitsend` CLI: preflights a message body against every core rule and
 * prints a human-readable (or --json) report. `runCli` is pure I/O-wise —
 * all output goes through the injected `out` callback, nothing touches
 * process.exit — so it's directly testable; the bottom of this file is the
 * thin bin entry that wires it to argv/console/process.exit.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CAMPAIGN_TYPES, PreflightInputError, preflight } from "./core/index.js";
import type { CampaignType, Finding, PreflightInput, PreflightReport, Verdict } from "./core/index.js";

const USAGE = `Usage: willitsend <message> [options]

Options:
  --first-message      Mark this as the first message to this contact
  --not-first          Mark this as NOT the first message to this contact
  --brand <name>       Brand name that should appear in the message
  --to <destination>   Destination: E.164 phone, email, short code, or grp_ id
  --campaign <type>    10DLC campaign tier (${CAMPAIGN_TYPES.join(", ")})
  --json               Print the full report as JSON
  --strict             Exit 1 on warnings too, not just blocks
  --help               Show this help text
  --                   End of options; the next argument is the message

Exit codes: 0 pass/warn, 1 block (or warn under --strict), 2 needs_context, 3 usage error.`;

interface CliArgs {
  input: PreflightInput;
  json: boolean;
  strict: boolean;
}

type ParseResult = { ok: true; args: CliArgs } | { ok: false; help: boolean };

function isCampaignType(value: string): value is CampaignType {
  return (CAMPAIGN_TYPES as readonly string[]).includes(value);
}

function parseArgs(argv: string[]): ParseResult {
  let body: string | undefined;
  let isFirst: boolean | undefined;
  let brand: string | undefined;
  let to: string | undefined;
  let campaign: CampaignType | undefined;
  let json = false;
  let strict = false;
  // POSIX end-of-options marker: everything after a standalone "--" is
  // positional, so bodies that start with "--" stay lintable.
  let optionsEnded = false;

  if (!argv.includes("--") && argv.includes("--help")) return { ok: false, help: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (optionsEnded) {
      if (body !== undefined) return { ok: false, help: false };
      body = arg;
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg === "--help") return { ok: false, help: true };
    switch (arg) {
      case "--first-message":
        isFirst = true;
        break;
      case "--not-first":
        isFirst = false;
        break;
      case "--json":
        json = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--brand": {
        const value = argv[++i];
        if (value === undefined) return { ok: false, help: false };
        brand = value;
        break;
      }
      case "--to": {
        const value = argv[++i];
        if (value === undefined) return { ok: false, help: false };
        to = value;
        break;
      }
      case "--campaign": {
        const value = argv[++i];
        if (value === undefined || !isCampaignType(value)) return { ok: false, help: false };
        campaign = value;
        break;
      }
      default:
        if (arg.startsWith("--")) return { ok: false, help: false };
        if (body !== undefined) return { ok: false, help: false };
        body = arg;
    }
  }

  if (body === undefined) return { ok: false, help: false };

  const input: PreflightInput = {
    body,
    ...(isFirst !== undefined ? { is_first_message_to_contact: isFirst } : {}),
    ...(brand !== undefined ? { brand_name: brand } : {}),
    ...(to !== undefined ? { to_number: to } : {}),
    ...(campaign !== undefined ? { campaign_type: campaign } : {}),
  };

  return { ok: true, args: { input, json, strict } };
}

function formatFinding(finding: Finding): string[] {
  const condition = finding.condition ? ` [depends on: ${finding.condition}]` : "";
  const lines = [`[${finding.severity.toUpperCase()}] ${finding.rule}: ${finding.message}${condition}`];
  if (finding.fix !== undefined) lines.push(`  Fix: ${finding.fix}`);
  lines.push(`  Source: ${finding.source.url}`);
  return lines;
}

function formatReport(report: PreflightReport): string[] {
  const lines: string[] = [`Verdict: ${report.verdict.toUpperCase()}`];

  const seg = report.trace.segments;
  const unitLabel = seg.encoding === "ucs2" ? "code units" : "septets";
  lines.push(`Segments: ${seg.segments} (${seg.encoding}, ${seg.units} ${unitLabel})`);
  lines.push(`Channel: ${report.trace.channel_assumption}`);

  if (report.verdict === "needs_context") {
    lines.push(
      "Needs context: this message has block-severity findings that depend on context left " +
        "unknown (e.g. is_first_message_to_contact, destination_capabilities). Provide it for a " +
        "definitive pass/block verdict.",
    );
  }

  if (report.findings.length === 0) lines.push("No findings.");
  for (const finding of report.findings) lines.push(...formatFinding(finding));

  for (const note of report.trace.notes) lines.push(`Note: ${note}`);

  return lines;
}

function exitCode(verdict: Verdict, strict: boolean): number {
  switch (verdict) {
    case "pass":
      return 0;
    case "warn":
      return strict ? 1 : 0;
    case "block":
      return 1;
    case "needs_context":
      return 2;
  }
}

/**
 * Runs the CLI against `argv` (already stripped of `node script.js`),
 * writing every output line through `out`. Returns the process exit code;
 * never calls process.exit itself so it stays unit-testable.
 */
export function runCli(argv: string[], out: (line: string) => void): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const line of USAGE.split("\n")) out(line);
    return parsed.help ? 0 : 3;
  }

  const { input, json, strict } = parsed.args;

  let report: PreflightReport;
  try {
    report = preflight(input);
  } catch (err) {
    if (err instanceof PreflightInputError) {
      out(`Error: ${err.message}`);
      for (const line of USAGE.split("\n")) out(line);
      return 3;
    }
    throw err;
  }

  if (json) {
    out(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatReport(report)) out(line);
  }

  return exitCode(report.verdict, strict);
}

/**
 * True when this module is the executed entry point. argv[1] is realpathed
 * because npm bin shims are symlinks, while import.meta.url resolves to the
 * real file — comparing them raw makes every `npx willitsend` a silent no-op.
 */
export function isCliEntry(argvPath: string | undefined, moduleUrl: string): boolean {
  if (argvPath === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  const code = runCli(process.argv.slice(2), console.log);
  process.exit(code);
}
