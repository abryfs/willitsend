// Verifies that every cited source still contains the facts the rules encode.
// Run weekly in CI; a failure means a source changed and a rule or citation
// needs a human (or agent) review — never an automatic rewrite.
const checks = [
  {
    url: "https://docs.agentphone.ai/documentation/reference/messaging-rate-limits.md",
    mustContain: [
      "silently filtered by carriers",
      "will not return an error",
      "First message requirements",
      "tripling the T-Mobile figure",
      "50 new contacts",
      "200,000",
    ],
  },
  {
    url: "https://docs.agentphone.ai/documentation/reference/messaging-rate-limits",
    mustContain: [
      'id="first-message-requirements"',
      'id="delivery-and-reliability"',
      'id="daily-message-limits"',
      'id="imessage"',
    ],
  },
  {
    url: "https://docs.agentphone.ai/documentation/guides/messages.md",
    mustContain: ["send_style", "confetti", "slam", "silently ignored"],
  },
  {
    url: "https://docs.agentphone.ai/documentation/guides/messages",
    mustContain: ['id="send-effects"', 'id="imessage"'],
  },
  {
    url: "https://docs.agentphone.ai/api-reference/messages/send-message-v-1-messages-post.md",
    mustContain: ["2-20", "carousel"],
  },
  {
    url: "https://docs.agentphone.ai/api-reference/messages/send-message-v-1-messages-post",
    mustContain: ['id="carousel--multi-image-imessage"'],
  },
  {
    url: "https://www.twilio.com/en-us/guidelines/us/sms",
    mustContain: ["SHAFT"],
  },
  {
    url: "https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf",
    statusOnly: true, // PDF text is compressed; presence + type is the check
    contentType: "pdf",
  },
];

let failures = [];
for (const check of checks) {
  try {
    const res = await fetch(check.url, { redirect: "follow" });
    if (!res.ok) {
      failures.push(`${check.url} -> HTTP ${res.status}`);
      continue;
    }
    if (check.statusOnly) {
      const ct = res.headers.get("content-type") ?? "";
      if (check.contentType && !ct.includes(check.contentType)) {
        failures.push(`${check.url} -> content-type "${ct}" (expected ${check.contentType})`);
      }
      continue;
    }
    const body = await res.text();
    for (const needle of check.mustContain) {
      if (!body.includes(needle)) failures.push(`${check.url} -> missing: ${JSON.stringify(needle)}`);
    }
  } catch (err) {
    failures.push(`${check.url} -> ${err.message ?? err}`);
  }
}

if (failures.length > 0) {
  console.error("SOURCE DRIFT DETECTED:\n" + failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}
console.log(`All ${checks.length} sources still support their cited facts.`);
