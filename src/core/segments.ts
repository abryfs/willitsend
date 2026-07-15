/**
 * GSM-7 / UCS-2 encoding detection and SMS segment math (3GPP TS 23.038).
 *
 * Pure, O(n) in body length: one pass to classify code points, one pass to
 * pack them into segments. No regex — table membership is plain Set lookups.
 */

import type { Encoding, SegmentInfo } from "./types.js";

/** GSM 7-bit default alphabet, basic table (1 septet each). */
const GSM_BASIC = new Set(
  Array.from(
    `@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,-./:;<=>?¡ÄÖÑÜ§¿äöñüà` +
      "0123456789" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
      "abcdefghijklmnopqrstuvwxyz",
  ),
);

/** GSM 7-bit default alphabet, extension table (ESC + char = 2 septets each). */
const GSM_EXTENDED = new Set(Array.from("\f^{}\\[]~|€"));

const SINGLE_CAP: Record<"gsm7" | "ucs2", number> = { gsm7: 160, ucs2: 70 };
const MULTI_CAP: Record<"gsm7" | "ucs2", number> = { gsm7: 153, ucs2: 67 };
const NON_GSM_CAP = 10;

interface Atom {
  /** The code point, as a 1- or 2-UTF-16-unit string. */
  text: string;
  inBasic: boolean;
  inExtended: boolean;
}

/**
 * Splits `body` into code-point atoms (via `for...of`, so a lone surrogate
 * is its own 1-unit atom rather than throwing or merging).
 */
function toAtoms(body: string): Atom[] {
  const atoms: Atom[] = [];
  for (const text of body) {
    atoms.push({ text, inBasic: GSM_BASIC.has(text), inExtended: GSM_EXTENDED.has(text) });
  }
  return atoms;
}

/**
 * Greedily packs per-atom unit costs into segments of `singleCap` (if
 * everything fits in one) or `multiCap` per part otherwise. A 2-unit atom
 * (GSM extension char, or a UCS-2 surrogate pair) never splits across parts:
 * a part is closed before an atom that would push it over capacity.
 */
function pack(costs: number[], singleCap: number, multiCap: number): number[] {
  const total = costs.reduce((sum, c) => sum + c, 0);
  if (total === 0) return [];
  if (total <= singleCap) return [total];

  const parts: number[] = [];
  let current = 0;
  for (const cost of costs) {
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
  const atoms = toAtoms(body);

  if (atoms.length === 0) {
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

  const encoding: Encoding = atoms.every((a) => a.inBasic || a.inExtended) ? "gsm7" : "ucs2";

  const nonGsmChars: string[] = [];
  const extensionChars: string[] = [];
  const seenNonGsm = new Set<string>();
  const seenExtension = new Set<string>();
  const costs: number[] = [];

  for (const atom of atoms) {
    if (atom.inExtended && !seenExtension.has(atom.text)) {
      seenExtension.add(atom.text);
      extensionChars.push(atom.text);
    }
    if (!atom.inBasic && !atom.inExtended && !seenNonGsm.has(atom.text)) {
      if (nonGsmChars.length < NON_GSM_CAP) {
        seenNonGsm.add(atom.text);
        nonGsmChars.push(atom.text);
      }
    }
    costs.push(encoding === "gsm7" ? (atom.inExtended ? 2 : 1) : atom.text.length);
  }

  const units = costs.reduce((sum, c) => sum + c, 0);
  const perSegment = pack(costs, SINGLE_CAP[encoding], MULTI_CAP[encoding]);

  return {
    encoding,
    units,
    chars: atoms.length,
    segments: perSegment.length,
    perSegment,
    nonGsmChars,
    extensionChars,
  };
}
