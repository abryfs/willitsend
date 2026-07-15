// Playground wiring. Imports the engine straight from src/core so this page
// can never disagree with the library.
import { preflight } from "../src/core/index.js";
import type { CampaignType, Finding, PreflightInput, PreflightReport } from "../src/core/index.js";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const bodyEl = $<HTMLTextAreaElement>("#body");
const brandEl = $<HTMLInputElement>("#brand");
const toEl = $<HTMLInputElement>("#to");
const campaignEl = $<HTMLSelectElement>("#campaign");
const bubbleEl = $("#bubble");
const receiptsEl = $("#receipts");
const verdictEl = $("#verdict");
const verdictWordEl = $("#verdict-word");
const verdictWhyEl = $("#verdict-why");
const findingsEl = $("#findings");
const segMetaEl = $("#seg-meta");
const rulerEl = $("#ruler");
const culpritsEl = $("#culprits");
const quotaEl = $("#quota");
const notesEl = $("#notes");

let firstMessage: "unknown" | "yes" | "no" = "unknown";

const PRESETS: Record<string, { body: string; first: typeof firstMessage; brand: string; to: string }> = {
  compliant: {
    body: "Acme Dental: thanks for signing up for appointment reminders. Your cleaning is tomorrow at 2pm. Reply STOP to unsubscribe.",
    first: "yes",
    brand: "Acme Dental",
    to: "+14155552671",
  },
  "missing-optout": {
    body: "Hi! Your appointment is confirmed for tomorrow at 2pm. See you then!",
    first: "yes",
    brand: "Acme Dental",
    to: "+14155552671",
  },
  emoji: {
    body: "Your table is ready \u{1F389} Come to the front desk when you arrive. We're excited to host your party of six tonight at seven thirty, see you soon!",
    first: "no",
    brand: "",
    to: "+14155552671",
  },
  hype: {
    body: "WINNER ALERT!!! Claim your FREE bottle of whiskey now → https://bit.ly/3xYz $$$ offers end tonight",
    first: "no",
    brand: "",
    to: "+14155552671",
  },
};

const VERDICT_COPY: Record<PreflightReport["verdict"], { word: string; why: string }> = {
  pass: { word: "PASS", why: "Nothing here that carriers are documented to filter." },
  warn: { word: "WARN", why: "Deliverable, but it carries known filtering risk." },
  block: { word: "BLOCK", why: "Carriers may silently drop this. The API would still say “sent”." },
  needs_context: {
    word: "NEEDS CONTEXT",
    why: "The verdict depends on whether this is the first message to this contact — set it on the left.",
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function buildInput(): PreflightInput | null {
  const body = bodyEl.value;
  if (body.length === 0) return null;
  const input: PreflightInput = { body };
  if (firstMessage !== "unknown") input.is_first_message_to_contact = firstMessage === "yes";
  const brand = brandEl.value.trim();
  if (brand) input.brand_name = brand;
  const to = toEl.value.replace(/[\s()-]/g, "");
  if (to) input.to_number = to;
  if (campaignEl.value) input.campaign_type = campaignEl.value as CampaignType;
  return input;
}

function renderFinding(f: Finding): string {
  const cond =
    f.condition === "first_message"
      ? '<span class="cond">if first message</span>'
      : f.condition
        ? `<span class="cond">if ${esc(f.condition.replace(/_/g, " "))}</span>`
        : "";
  const fix = f.fix ? `<div class="fix">fix: <code>${esc(f.fix)}</code></div>` : "";
  const src = f.source.url.startsWith("https://")
    ? `<a class="src" href="${esc(f.source.url)}" target="_blank" rel="noopener">source: ${esc(f.source.kind)} ↗</a>`
    : `<span class="src">source: ${esc(f.source.kind)}</span>`;
  return `<div class="finding ${f.severity}">
    <div class="rule"><span class="sev">${f.severity.toUpperCase()}</span> <span>${esc(f.rule)}</span> ${cond}</div>
    <div class="msg">${esc(f.message)}</div>
    ${fix}
    ${src}
  </div>`;
}

function render(): void {
  const input = buildInput();
  bubbleEl.textContent = bodyEl.value;

  if (!input) {
    verdictEl.className = "verdict needs_context";
    verdictWordEl.textContent = "—";
    verdictWhyEl.textContent = "Type a message to run preflight.";
    findingsEl.innerHTML = '<p class="none">No findings yet.</p>';
    segMetaEl.innerHTML = "";
    rulerEl.innerHTML = "";
    culpritsEl.textContent = "";
    quotaEl.textContent = "";
    notesEl.textContent = "";
    receiptsEl.innerHTML = "";
    bubbleEl.className = "bubble";
    return;
  }

  let report: PreflightReport;
  try {
    report = preflight(input);
  } catch (err) {
    verdictEl.className = "verdict needs_context";
    verdictWordEl.textContent = "INPUT";
    verdictWhyEl.textContent = err instanceof Error ? err.message : String(err);
    return;
  }

  // verdict banner
  const copy = VERDICT_COPY[report.verdict];
  verdictEl.className = `verdict ${report.verdict}`;
  verdictWordEl.textContent = copy.word;
  verdictWhyEl.textContent = copy.why;

  // bubble fate
  const imessage = report.trace.channel_assumption === "imessage";
  bubbleEl.className = `bubble${imessage ? " imessage" : ""}${report.verdict === "block" ? " ghost" : ""}`;
  if (report.verdict === "block") {
    receiptsEl.innerHTML = 'API: "sent" ✓ &nbsp;·&nbsp; <span class="never">phone: may never arrive</span>';
  } else if (report.verdict === "needs_context") {
    receiptsEl.innerHTML = 'API: "sent" ✓ &nbsp;·&nbsp; phone: depends on context';
  } else {
    receiptsEl.innerHTML = `Delivered · ${imessage ? "iMessage" : "SMS"}`;
  }

  // findings
  findingsEl.innerHTML = report.findings.length
    ? report.findings.map(renderFinding).join("")
    : '<p class="none">Clean. No findings.</p>';

  // segments
  const seg = report.trace.segments;
  if (seg.encoding === "none") {
    segMetaEl.innerHTML = "";
    rulerEl.innerHTML = "";
    culpritsEl.textContent = "";
  } else {
    const unitName = seg.encoding === "gsm7" ? "septets" : "UTF-16 units";
    segMetaEl.innerHTML =
      `<span class="badge${seg.encoding === "ucs2" ? " ucs2" : ""}">${seg.encoding === "gsm7" ? "GSM-7" : "UCS-2"}</span>` +
      `<span><b>${seg.segments}</b> segment${seg.segments === 1 ? "" : "s"}</span>` +
      `<span><b>${seg.units}</b> ${unitName}</span>` +
      `<span><b>${seg.chars}</b> chars</span>`;
    rulerEl.innerHTML = seg.perSegment
      .map((units, i) => `<div class="cell${seg.encoding === "ucs2" ? " hot" : ""}">S${i + 1} · ${units}</div>`)
      .join("");
    culpritsEl.textContent =
      seg.encoding === "ucs2" && seg.nonGsmChars.length
        ? `UCS-2 forced by: ${seg.nonGsmChars.join(" ")}`
        : seg.extensionChars.length
          ? `2-septet chars: ${seg.extensionChars.join(" ")}`
          : "";
  }

  // quota
  const q = report.trace.quota;
  quotaEl.innerHTML = q
    ? `daily-cap math (${esc(q.campaign_type)}): <b>${q.segments_per_message}</b> segment(s)/message × ` +
      `est. <b>${q.estimated_total_daily_cap.toLocaleString()}</b> segments/day ≈ ` +
      `<b>${q.messages_per_day_estimate.toLocaleString()}</b> messages/day · estimate from published caps`
    : "";

  notesEl.textContent = report.trace.notes.join(" · ");
}

let pending: number | undefined;
function scheduleRender(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = window.setTimeout(render, 90);
}

bodyEl.addEventListener("input", scheduleRender);
brandEl.addEventListener("input", scheduleRender);
toEl.addEventListener("input", scheduleRender);
campaignEl.addEventListener("change", scheduleRender);

for (const btn of document.querySelectorAll<HTMLButtonElement>(".seg-control button")) {
  btn.addEventListener("click", () => {
    firstMessage = btn.dataset.first as typeof firstMessage;
    for (const b of document.querySelectorAll<HTMLButtonElement>(".seg-control button")) {
      b.setAttribute("aria-pressed", String(b === btn));
    }
    render();
  });
}

for (const chip of document.querySelectorAll<HTMLButtonElement>(".chip")) {
  chip.addEventListener("click", () => {
    const preset = PRESETS[chip.dataset.preset ?? ""];
    if (!preset) return;
    bodyEl.value = preset.body;
    brandEl.value = preset.brand;
    toEl.value = preset.to;
    firstMessage = preset.first;
    for (const b of document.querySelectorAll<HTMLButtonElement>(".seg-control button")) {
      b.setAttribute("aria-pressed", String(b.dataset.first === preset.first));
    }
    render();
  });
}

render();
