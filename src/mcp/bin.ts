#!/usr/bin/env node
/**
 * stdio entry point for the willitsend MCP server. stdout is the protocol
 * channel, so nothing here may use console.log — errors go to stderr only.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.AGENTPHONE_API_KEY;
  const server = createServer(apiKey !== undefined ? { apiKey } : {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
