/**
 * GSM-7 / UCS-2 encoding detection and SMS segment math (3GPP TS 23.038).
 *
 * Pure, O(n) in body length: one pass over code points (classifying via a
 * numeric lookup table, no per-atom allocation) plus a short pass over the
 * resulting per-atom cost array to pack segments. No regex, no backtracking.
 */

import type { Encoding, SegmentInfo } from "./types.js";

/** GSM 7-bit default alphabet, basic table (1 septet each). */
const GSM_BASIC_CHARS =
  `@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,-./:;<=>?¡ÄÖÑÜ§¿äöñüà` +
  "0123456789" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "abcdefghijklmnopqrstuvwxyz";

/** GSM 7-bit default alphabet, extension table (ESC + char = 2 septets each). */
const GSM_EXTENDED_CHARS = "\f^{}\\[]~|€";

/**
 * Code-point -> class lookup, sized to cover every character in both GSM
 * tables (the highest is € at U+20AC). 0 = not in either table, 1 = basic,
 * 2 = extended. Built once at module load; the hot path is then a single
 * array index instead of a string Set lookup.
 */
const GSM_TABLE_SIZE = 0x2100;
const GSM_CLASS = new Uint8Array(GSM_TABLE_SIZE);
for (const ch of GSM_BASIC_CHARS) GSM_CLASS[ch.codePointAt(0)!] = 1;
for (const ch of GSM_EXTENDED_CHARS) GSM_CLASS[ch.codePointAt(0)!] = 2;

const SINGLE_CAP: Record<"gsm7" | "ucs2", number> = { gsm7: 160, ucs2: 70 };
const MULTI_CAP: Record<"gsm7" | "ucs2", number> = { gsm7: 153, ucs2: 67 };
const NON_GSM_CAP = 10;

/**
 * Greedily packs per-atom unit costs (`costs[0..length)`) into segments of
 * `singleCap` (if everything fits in one) or `multiCap` per part otherwise.
 * A 2-unit atom (GSM extension char, or a UCS-2 surrogate pair) never splits
 * across parts: a part is closed before an atom that would push it over
 * capacity. `total` is the precomputed sum of `costs[0..length)`.
 */
function pack(costs: Uint8Array, length: number, total: number, singleCap: number, multiCap: number): number[] {
  if (total === 0) return [];
  if (total <= singleCap) return [total];

  const parts: number[] = [];
  let current = 0;
  for (let i = 0; i < length; i++) {
    const cost = costs[i] ?? 0;
    if (current + cost > multiCap) {
      parts.push(current);
      current = 0;
    }
    current += cost;
  }
  parts.push(current);
  return parts;
}

/** Analyzes an SMS body for GSM-7/UCS-2 encoding, unit counts, and segmentation. */
export function analyzeSegments(body: string): SegmentInfo {
  const len = body.length;
  if (len === 0) {
    return {
      encoding: "none",
      units: 0,
      chars: 0,
      segments: 0,
      perSegment: [],
      nonGsmChars: [],
      extensionChars: [],
    };
  }

  // Upper bound: at most `len` code points (astral code points use 2 UTF-16
  // units for 1 atom, so the real atom count is <= len).
  const costs = new Uint8Array(len);
  const extendedIdx: number[] = [];
  const nonGsmChars: string[] = [];
  const extensionChars: string[] = [];
  const seenNonGsm = new Set<string>();
  const seenExtension = new Set<string>();

  let chars = 0;
  let allGsm = true;
  let ucs2Total = 0;

  let i = 0;
  while (i < len) {
    const cp = body.codePointAt(i)!;
    const wide = cp > 0xffff;
    const cls = cp < GSM_TABLE_SIZE ? GSM_CLASS[cp] : 0;

    if (cls === 0) {
      allGsm = false;
      if (nonGsmChars.length < NON_GSM_CAP) {
        const text = String.fromCodePoint(cp);
        if (!seenNonGsm.has(text)) {
          seenNonGsm.add(text);
          nonGsmChars.push(text);
        }
      }
    } else if (cls === 2) {
      const text = String.fromCodePoint(cp);
      if (!seenExtension.has(text)) {
        seenExtension.add(text);
        extensionChars.push(text);
      }
      extendedIdx.push(chars);
    }

    const unitCost = wide ? 2 : 1;
    costs[chars] = unitCost;
    ucs2Total += unitCost;
    chars++;
    i += wide ? 2 : 1;
  }

  const encoding: "gsm7" | "ucs2" = allGsm ? "gsm7" : "ucs2";
  let units: number;
  if (encoding === "ucs2") {
    units = ucs2Total;
  } else {
    // Every GSM-eligible code point is BMP, so `costs` is currently all 1s;
    // fix up the (rare) extension-table atoms to their real 2-septet cost.
    for (const idx of extendedIdx) costs[idx] = 2;
    units = chars + extendedIdx.length;
  }

  const perSegment = pack(costs, chars, units, SINGLE_CAP[encoding], MULTI_CAP[encoding]);

  return {
    encoding,
    units,
    chars,
    segments: perSegment.length,
    perSegment,
    nonGsmChars,
    extensionChars,
  };
}

/**
 * Internal fast path for the unicode-blowup rule: the segment count `body`
 * would have if every code point in `exclude` were absent, without
 * allocating a stripped string or the full `SegmentInfo` shape. `exclude`
 * holds code points (not substrings), so the per-character loop never
 * allocates a string just to check membership.
 */
export function segmentCountExcluding(body: string, exclude: ReadonlySet<number>): number {
  const len = body.length;
  if (len === 0) return 0;

  const costs = new Uint8Array(len);
  const extendedIdx: number[] = [];
  let chars = 0;
  let allGsm = true;
  let ucs2Total = 0;

  let i = 0;
  while (i < len) {
    const cp = body.codePointAt(i)!;
    const wide = cp > 0xffff;
    i += wide ? 2 : 1;
    if (exclude.has(cp)) continue;

    const cls = cp < GSM_TABLE_SIZE ? GSM_CLASS[cp] : 0;
    if (cls === 0) allGsm = false;
    else if (cls === 2) extendedIdx.push(chars);

    const unitCost = wide ? 2 : 1;
    costs[chars] = unitCost;
    ucs2Total += unitCost;
    chars++;
  }

  if (chars === 0) return 0;

  const encoding: "gsm7" | "ucs2" = allGsm ? "gsm7" : "ucs2";
  let units: number;
  if (encoding === "ucs2") {
    units = ucs2Total;
  } else {
    for (const idx of extendedIdx) costs[idx] = 2;
    units = chars + extendedIdx.length;
  }

  return pack(costs, chars, units, SINGLE_CAP[encoding], MULTI_CAP[encoding]).length;
}
