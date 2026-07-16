# Changelog

## 0.1.0 — 2026-07-16

Initial release.

- Pure rules engine: first-message compliance (opt-out, brand, opt-in), GSM-7/UCS-2
  segment math with placement-aware packing, iMessage feature-fallback checks,
  advisory content rules. Every finding cites its source.
- Verdict model with `needs_context` (unknown context never yields a fake pass or block).
- MCP server (default `willitsend` bin, also `willitsend-mcp`), CLI (`willitsend-cli`),
  and browser playground.
- Discovery manifests (`server.json`, `smithery.yaml`, `glama.json`) and a
  publish-on-tag workflow for npm + the MCP Registry (`io.github.abryfs/willitsend`).
- Segment math at parity with Twilio's reference calculator across a 126-vector corpus.
