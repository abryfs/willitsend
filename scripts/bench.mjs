// Measures preflight() latency over a mixed corpus. Run: npm run build && node scripts/bench.mjs
import { preflight } from "../dist/core/index.js";

const corpus = [
  { body: "Acme: thanks for signing up for alerts. Reply STOP to unsubscribe.", is_first_message_to_contact: true, brand_name: "Acme" },
  { body: "Hey, quick reminder about tomorrow at 2pm." },
  { body: "Your table is ready \u{1F389} Come to the front desk when you arrive. Party of six at 7:30!", is_first_message_to_contact: false },
  { body: "WINNER ALERT!!! Claim your FREE bottle now https://bit.ly/3xYz $$$", is_first_message_to_contact: false, to_number: "+14155552671" },
  { body: "a".repeat(918), is_first_message_to_contact: false, campaign_type: "sole_proprietor" },
  { body: ("The quick brown fox \u{1F98A} jumps. ").repeat(30), is_first_message_to_contact: false },
];

// warmup
for (let i = 0; i < 2_000; i++) preflight(corpus[i % corpus.length]);

const ITER = 50_000;
const times = new Float64Array(ITER);
for (let i = 0; i < ITER; i++) {
  const input = corpus[i % corpus.length];
  const t0 = performance.now();
  preflight(input);
  times[i] = performance.now() - t0;
}

const sorted = [...times].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(ITER - 1, Math.floor((p / 100) * ITER))];
const total = times.reduce((a, b) => a + b, 0);
console.log(`iterations: ${ITER}`);
console.log(`median: ${(pct(50) * 1000).toFixed(1)}µs  p99: ${(pct(99) * 1000).toFixed(1)}µs  max: ${(sorted[ITER - 1] * 1000).toFixed(0)}µs`);
console.log(`throughput: ${Math.round(ITER / (total / 1000)).toLocaleString()} messages/sec (single thread)`);
