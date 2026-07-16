/**
 * MCP server exposing willitsend's preflight engine as a single read-only
 * tool: `preflight_message`. It never sends anything — it lints a draft
 * message and hands back a verdict, cited findings, and a send trace so an
 * agent can decide whether to actually call its messaging tool.
 *
 * Optional enrichment: when `apiKey` is configured and the caller gives a
 * bare `to_number` (no `destination_capabilities` of its own), the server
 * does a live capabilities lookup against AgentPhone. That lookup is
 * best-effort — any failure (bad status, timeout, malformed body) degrades
 * to "capabilities unknown" plus a note in the trace; it never fails the
 * tool call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { classifyDestination } from "../core/destination.js";
import { CAMPAIGN_TYPES, PreflightInputError, preflight } from "../core/index.js";
import type { DestinationCapabilities, Finding, PreflightInput, PreflightReport } from "../core/index.js";

/** Keep in sync with package.json "version" — not read at runtime on purpose. */
const SERVER_VERSION = "0.1.0";

const CAPABILITIES_URL = "https://api.agentphone.ai/v1/contacts/capabilities";
const CAPABILITIES_TIMEOUT_MS = 5000;

export interface CreateServerOptions {
  /** AgentPhone API key. Enables the optional live capabilities lookup. */
  apiKey?: string;
  /** Override for `fetch`, mainly for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const TOOL_DESCRIPTION =
  "Analyzes (lints) a draft SMS/iMessage BEFORE you send it — it sends nothing itself, makes no " +
  "delivery attempt, and has no side effects. Call this first, before send_message or any other " +
  "messaging tool, on every outbound draft. Returns: a verdict (pass, warn, block, or " +
  "needs_context — block-severity issues that depend on context you didn't provide, like whether " +
  "this is the first message to this contact); a list of findings, each with a severity, a stable " +
  "rule id, a plain-language explanation, an optional concrete fix, and a citation URL (AgentPhone " +
  "docs, CTIA, or Twilio guidelines) backing the rule; and a send trace with the destination " +
  "classification, the assumed delivery channel (imessage/sms/mms/unknown), SMS segment math " +
  "(encoding, segment count), and — given a 10DLC campaign_type — a daily-quota illustration. Use " +
  "it to catch carrier-filtering risks (missing opt-out language, missing brand identification, " +
  "missing opt-in wording on first messages), invalid iMessage send_style values, oversized media " +
  "carousels, and GSM-7/UCS-2 segment blowups from stray unicode before spending a real send. " +
  "Every finding's fix field is directly actionable: apply it to the draft verbatim (e.g. append " +
  "the exact quoted sentence), then call preflight_message again — loop until the verdict is pass. " +
  "Never treat needs_context as permission to send; supply the missing context and re-check.";

const inputSchema = {
  body: z
    .string()
    .describe(
      "The exact message text to preflight. Pass an empty string for a media-only send. This " +
        "text is used only for local analysis — the tool never stores or forwards it anywhere.",
    ),
  to_number: z
    .string()
    .optional()
    .describe(
      "Single destination: E.164 phone number (e.g. +15551234567), email (iMessage only), a 5-6 " +
        "digit short code, or a grp_ group id. Omit when using `recipients` for a multi-recipient group.",
    ),
  recipients: z
    .array(z.string())
    .optional()
    .describe(
      "2+ destinations to create a new iMessage group (iMessage only, never delivers as SMS). " +
        "Do not combine with to_number.",
    ),
  media_urls: z
    .array(z.string())
    .optional()
    .describe(
      "Media attachment URLs. 2-20 entries triggers an iMessage carousel; check the returned " +
        "findings for carousel-size warnings on other channels.",
    ),
  send_style: z
    .string()
    .optional()
    .describe(
      "iMessage-only visual send effect (e.g. \"confetti\", \"slam\"). Silently dropped outside " +
        "iMessage — flagged unless the channel is confirmed iMessage.",
    ),
  reply_to_message_id: z.string().optional().describe("iMessage-only threaded reply target message id."),
  is_first_message_to_contact: z
    .boolean()
    .optional()
    .describe(
      "Whether this is the first outbound message ever sent to this contact. Set true or false " +
        "when you know it — first messages carry stricter compliance rules (opt-out language, " +
        "brand identification, opt-in wording). Leave unset only if genuinely unknown; the tool " +
        "then reports affected findings as conditional instead of asserting them (verdict " +
        "needs_context).",
    ),
  brand_name: z
    .string()
    .optional()
    .describe(
      "Sender brand or company name that should be identifiable in a first message. Without it " +
        "the brand-identification check degrades to advisory only.",
    ),
  campaign_type: z
    .enum(CAMPAIGN_TYPES)
    .optional()
    .describe("10DLC campaign tier, if known, to attach a static daily-send-cap illustration to the trace."),
  destination_capabilities: z
    .object({ imessage: z.boolean(), sms: z.boolean() })
    .optional()
    .describe(
      "Known delivery capabilities for the destination, if you already looked them up. Passing " +
        "this explicitly always takes precedence over — and skips — this server's own optional lookup.",
    ),
  destination_line_type: z
    .enum(["mobile", "voip", "landline", "unknown"])
    .optional()
    .describe(
      "Destination phone line type, if known from an external lookup. Never guess this from the " +
        "number itself — VoIP lines often have unreliable iMessage/SMS delivery.",
    ),
};

const findingSourceSchema = z.looseObject({
  kind: z.enum(["agentphone-docs", "ctia", "twilio", "heuristic"]),
  url: z.string(),
});

const findingSchema = z.looseObject({
  rule: z.string(),
  severity: z.enum(["block", "warn", "info"]),
  message: z.string(),
  source: findingSourceSchema,
});

const destinationSchema = z.looseObject({
  raw: z.string().optional(),
  class: z.enum(["e164", "email", "short_code", "group_id", "unknown"]),
});

const segmentInfoSchema = z.looseObject({
  encoding: z.enum(["gsm7", "ucs2", "none"]),
  units: z.number(),
  chars: z.number(),
  segments: z.number(),
});

const traceSchema = z.looseObject({
  destination: destinationSchema,
  channel_assumption: z.enum(["imessage", "sms", "mms", "unknown"]),
  segments: segmentInfoSchema,
  notes: z.array(z.string()),
});

const outputSchema = {
  verdict: z.enum(["pass", "warn", "block", "needs_context"]),
  findings: z.array(findingSchema),
  trace: traceSchema,
};

function severityTag(severity: Finding["severity"]): string {
  return severity.toUpperCase();
}

/** Human summary text. Never includes the raw message body (privacy). */
function summarize(report: PreflightReport): string {
  const lines: string[] = [`Verdict: ${report.verdict.toUpperCase()}`];

  const seg = report.trace.segments;
  const unitLabel = seg.encoding === "ucs2" ? "code units" : "septets";
  lines.push(`Segments: ${seg.segments} (${seg.encoding}, ${seg.units} ${unitLabel})`);
  lines.push(`Channel: ${report.trace.channel_assumption}`);

  if (report.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of report.findings) {
      const condition = finding.condition ? ` [depends on: ${finding.condition}]` : "";
      lines.push(`[${severityTag(finding.severity)}] ${finding.rule}: ${finding.message}${condition}`);
      if (finding.fix !== undefined) lines.push(`  Fix: ${finding.fix}`);
      lines.push(`  Source: ${finding.source.url}`);
    }
  }

  for (const note of report.trace.notes) lines.push(`Note: ${note}`);

  return lines.join("\n");
}

interface LookupResult {
  capabilities?: DestinationCapabilities;
  note?: string;
}

/** Best-effort capabilities lookup. Never throws — every failure mode maps to a note. */
async function lookupCapabilities(apiKey: string, toNumber: string, fetchImpl: typeof fetch): Promise<LookupResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPABILITIES_TIMEOUT_MS);
  try {
    const url = `${CAPABILITIES_URL}?phone_number=${encodeURIComponent(toNumber)}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        note: `capabilities lookup unavailable (HTTP ${response.status}); destination treated as unknown`,
      };
    }
    const data = (await response.json()) as { capabilities?: Partial<DestinationCapabilities> };
    const caps = data.capabilities;
    if (caps === undefined || typeof caps.imessage !== "boolean" || typeof caps.sms !== "boolean") {
      return { note: "capabilities lookup unavailable (malformed response); destination treated as unknown" };
    }
    return { capabilities: { imessage: caps.imessage, sms: caps.sms } };
  } catch {
    return {
      note: "capabilities lookup unavailable (request failed or timed out); destination treated as unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Builds the willitsend MCP server. Zero configuration required. */
export function createServer(opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "willitsend", version: SERVER_VERSION });

  server.registerTool(
    "preflight_message",
    {
      title: "Preflight a message before sending",
      description: TOOL_DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      let capabilities = args.destination_capabilities;
      const enrichmentNotes: string[] = [];

      if (
        opts.apiKey !== undefined &&
        args.to_number !== undefined &&
        args.destination_capabilities === undefined &&
        classifyDestination(args.to_number) === "e164"
      ) {
        const result = await lookupCapabilities(opts.apiKey, args.to_number, opts.fetchImpl ?? fetch);
        if (result.capabilities !== undefined) {
          capabilities = result.capabilities;
        } else if (result.note !== undefined) {
          enrichmentNotes.push(result.note);
        }
      }

      const input: PreflightInput = {
        body: args.body,
        ...(args.to_number !== undefined ? { to_number: args.to_number } : {}),
        ...(args.recipients !== undefined ? { recipients: args.recipients } : {}),
        ...(args.media_urls !== undefined ? { media_urls: args.media_urls } : {}),
        ...(args.send_style !== undefined ? { send_style: args.send_style } : {}),
        ...(args.reply_to_message_id !== undefined ? { reply_to_message_id: args.reply_to_message_id } : {}),
        ...(args.is_first_message_to_contact !== undefined
          ? { is_first_message_to_contact: args.is_first_message_to_contact }
          : {}),
        ...(args.brand_name !== undefined ? { brand_name: args.brand_name } : {}),
        ...(args.campaign_type !== undefined ? { campaign_type: args.campaign_type } : {}),
        ...(capabilities !== undefined ? { destination_capabilities: capabilities } : {}),
        ...(args.destination_line_type !== undefined
          ? { destination_line_type: args.destination_line_type }
          : {}),
      };

      let report: PreflightReport;
      try {
        report = preflight(input);
      } catch (err) {
        if (err instanceof PreflightInputError) {
          return {
            content: [{ type: "text" as const, text: `Invalid input: ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }

      if (enrichmentNotes.length > 0) {
        report.trace.notes = [...report.trace.notes, ...enrichmentNotes];
      }

      return {
        content: [{ type: "text" as const, text: summarize(report) }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
