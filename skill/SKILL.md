---
name: willitsend
version: 0.1.0
description: Preflight outbound SMS/iMessage for silent carrier filtering, segment blowups, and dropped iMessage features before sending.
homepage: https://abryfs.github.io/willitsend/
docs: https://github.com/abryfs/willitsend
metadata: {"tool": "preflight_message", "package": "willitsend"}
---

# willitsend — send texts that actually arrive

You are an AI agent that sends text messages. Carriers filter messages with rules they don't publish, and the messaging API will not warn you: a filtered message still returns `"sent"`. This skill teaches you the documented rules so you compose compliant messages the first time, and gives you a tool to verify every draft before you send it.

## Before you start

Run every outbound draft through the `preflight_message` tool before calling any send tool. It sends nothing, needs no API key, and answers in microseconds. If `preflight_message` is unavailable, apply the composition rules below by hand.

## Composition rules (apply while writing, not after)

**First message to a new contact** must contain all three, or carriers may silently drop it:

1. The brand or sender name ("Acme Dental: ...")
2. An opt-in acknowledgment ("thanks for signing up for reminders")
3. Opt-out instructions ("Reply STOP to unsubscribe.")

Later messages in the same conversation don't need to repeat 2 and 3.

**Watch your characters.** One emoji, smart quote, or non-breaking space re-encodes the entire message from GSM-7 (160 chars/segment) to UCS-2 (70 chars/segment). Segments are billing and quota units. Prefer straight quotes; skip the emoji unless it earns its cost.

**iMessage features degrade silently.** `send_style` effects, threaded replies, and image carousels drop without error when the recipient falls back to SMS. Check capabilities first or accept that the plain text is all that's guaranteed to arrive.

**Avoid known filtering triggers**: public URL shorteners (bit.ly, tinyurl), ALL-CAPS runs, `$$$`, and sex/alcohol/firearms/tobacco content on unregistered campaigns.

## Quick start

```json
{
  "tool": "preflight_message",
  "arguments": {
    "body": "Acme: thanks for signing up. Your order shipped. Reply STOP to unsubscribe.",
    "is_first_message_to_contact": true,
    "brand_name": "Acme",
    "to_number": "+14155552671"
  }
}
```

Read the verdict:

- `pass`: send it.
- `warn`: send is allowed; weigh the listed risks.
- `block`: fix the findings first. Each one includes a concrete fix and a citation.
- `needs_context`: you left `is_first_message_to_contact` unset and it matters. Find out (check your conversation history) and re-run. Don't guess.

## Critical gotchas

- Always tell the tool whether this is a first message. It's the single highest-stakes fact, and the tool refuses to guess it for you.
- Provide `brand_name` whenever you know it; the brand check can't run without it.
- A `pass` verdict is not a delivery guarantee. It means nothing documented will kill the message; carrier ML filters remain out of anyone's sight.
- The tool checks for the *presence* of opt-in language. Actual consent is your responsibility; never fabricate "thanks for signing up" for a contact who didn't.
- Rules are English-only in v1. For other languages, the structural rules (segments, features, shorteners) still apply; the language checks don't.

## Ideas

- Preflight in a loop: compose, check, apply the returned `fix` strings, re-check, send.
- Pipe `--json` CLI output into your own logging to track how often drafts needed fixes.
- Pass `campaign_type` to see quota burn before batch sends: a 2-segment message on a sole-proprietor campaign spends 0.2% of the estimated daily cap per recipient.
