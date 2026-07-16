import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";

// MCP server contract: one read-only tool, works with zero configuration,
// optional capabilities enrichment that degrades gracefully (G6/D5).

async function connect(opts?: Parameters<typeof createServer>[0]) {
  const server = createServer(opts);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

describe("tool surface", () => {
  it("exposes exactly one tool: preflight_message, marked read-only", async () => {
    const client = await connect();
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    const tool = tools.tools[0]!;
    expect(tool.name).toBe("preflight_message");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.description).toMatch(/sends nothing|does not send/i);
  });

  it("lints a message with zero configuration (no API key)", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: {
        body: "Hey, quick reminder about tomorrow at 2pm.",
        is_first_message_to_contact: true,
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/BLOCK/i);
    expect(text).toContain("STOP");
    expect(text).toContain("docs.agentphone.ai");
    expect((result.structuredContent as { verdict?: string }).verdict).toBe("block");
  });

  it("passes a compliant first message", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: {
        body: "Acme: thanks for signing up for alerts. Reply STOP to unsubscribe.",
        is_first_message_to_contact: true,
        brand_name: "Acme",
      },
    })) as ToolResult;
    expect((result.structuredContent as { verdict?: string }).verdict).toBe("pass");
  });

  it("invalid input is a usage error with an actionable message, not a crash", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: { body: "" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/body|media/i);
  });
});

describe("capabilities enrichment (optional, graceful)", () => {
  const CAPS_OK = async () =>
    new Response(
      JSON.stringify({
        phoneNumber: "+14155552671",
        capabilities: { imessage: true, sms: true },
        checkedAt: "2026-07-16T00:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("with api key + to_number, looks up capabilities and reflects them in the trace", async () => {
    let calledUrl = "";
    const client = await connect({
      apiKey: "test-key",
      fetchImpl: async (url: string | URL) => {
        calledUrl = String(url);
        return CAPS_OK();
      },
    });
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: {
        body: "hi again",
        to_number: "+14155552671",
        is_first_message_to_contact: false,
        send_style: "confetti",
      },
    })) as ToolResult;
    expect(calledUrl).toContain("/v1/contacts/capabilities");
    expect(calledUrl).toContain(encodeURIComponent("+14155552671"));
    const trace = (result.structuredContent as { trace?: { channel_assumption?: string } }).trace;
    expect(trace?.channel_assumption).toBe("imessage");
    // capabilities known-imessage: no conditional fallback warning
    const findings = (result.structuredContent as { findings?: { rule: string }[] }).findings ?? [];
    expect(findings.filter((f) => f.rule === "imessage.feature-fallback")).toEqual([]);
  });

  it("enrichment failure degrades gracefully — preflight still answers", async () => {
    const client = await connect({
      apiKey: "test-key",
      fetchImpl: async () => new Response("upstream down", { status: 503 }),
    });
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: {
        body: "hi again",
        to_number: "+14155552671",
        is_first_message_to_contact: false,
      },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { verdict?: string; trace?: { notes?: string[] } };
    expect(sc.verdict).toBeDefined();
    expect((sc.trace?.notes ?? []).join(" ")).toMatch(/capabilit/i);
  });

  it("no api key: never calls fetch", async () => {
    let called = false;
    const client = await connect({
      fetchImpl: async () => {
        called = true;
        return CAPS_OK();
      },
    });
    await client.callTool({
      name: "preflight_message",
      arguments: { body: "hi", to_number: "+14155552671", is_first_message_to_contact: false },
    });
    expect(called).toBe(false);
  });

  it("explicit destination_capabilities in arguments wins over lookup", async () => {
    let called = false;
    const client = await connect({
      apiKey: "test-key",
      fetchImpl: async () => {
        called = true;
        return CAPS_OK();
      },
    });
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: {
        body: "hi",
        to_number: "+14155552671",
        is_first_message_to_contact: false,
        destination_capabilities: { imessage: false, sms: true },
      },
    })) as ToolResult;
    expect(called).toBe(false);
    const trace = (result.structuredContent as { trace?: { channel_assumption?: string } }).trace;
    expect(trace?.channel_assumption).toBe("sms");
  });
});

describe("response_format", () => {
  it("concise returns actionable one-liners at a fraction of the tokens", async () => {
    const client = await connect();
    const args = { body: "Hey, quick reminder about tomorrow at 2pm.", is_first_message_to_contact: true };
    const detailed = (await client.callTool({ name: "preflight_message", arguments: args })) as ToolResult;
    const concise = (await client.callTool({
      name: "preflight_message",
      arguments: { ...args, response_format: "concise" },
    })) as ToolResult;
    const dText = detailed.content.find((c) => c.type === "text")?.text ?? "";
    const cText = concise.content.find((c) => c.type === "text")?.text ?? "";
    expect(cText).toMatch(/^BLOCK/);
    expect(cText).toContain("first-message.opt-out");
    expect(cText).toContain("Reply STOP");
    expect(cText.length).toBeLessThan(dText.length / 2);
    expect((concise.structuredContent as { verdict?: string }).verdict).toBe("block");
  });
});

describe("privacy (G13)", () => {
  it("tool result text never includes the full message body", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "preflight_message",
      arguments: { body: "SECRETBODYTOKEN meet at 2pm", is_first_message_to_contact: false },
    })) as ToolResult;
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).not.toContain("SECRETBODYTOKEN");
  });
});
