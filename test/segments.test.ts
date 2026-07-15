import { describe, expect, it } from "vitest";
import { analyzeSegments } from "../src/core/segments.js";

// Expected values hand-derived from 3GPP TS 23.038 (GSM 7-bit default
// alphabet + extension table) and cross-checked against Twilio's public
// message segment calculator for agreement on shared cases.
//
// Non-obvious characters are written as \u escapes so the fixtures can't
// be corrupted by editors or copy-paste normalization.

const NBSP = "\u00A0";
const ZWJ = "\u200D";
const RSQUO = "\u2019"; // ’

describe("encoding detection", () => {
  it("plain ASCII is GSM-7", () => {
    expect(analyzeSegments("hello world").encoding).toBe("gsm7");
  });

  it("GSM basic-table accents stay GSM-7 (é è ù ì ò à Ñ Ü)", () => {
    expect(analyzeSegments("café où ìò à ÑÜ").encoding).toBe("gsm7");
  });

  it("Greek uppercase from the basic table stays GSM-7", () => {
    expect(analyzeSegments("ΔΦΓΛΩΠΨΣΘΞ").encoding).toBe("gsm7");
  });

  it("lowercase ç is NOT GSM-7 (only Ç is)", () => {
    const r = analyzeSegments("français");
    expect(r.encoding).toBe("ucs2");
    expect(r.nonGsmChars).toEqual(["ç"]);
  });

  it("smart quotes flip the whole message to UCS-2", () => {
    const r = analyzeSegments(`It${RSQUO}s fine`);
    expect(r.encoding).toBe("ucs2");
    expect(r.nonGsmChars).toEqual([RSQUO]);
  });

  it("one emoji flips the whole message to UCS-2", () => {
    expect(analyzeSegments("on my way \u{1F44D}").encoding).toBe("ucs2");
  });

  it("non-breaking space is not GSM-7", () => {
    expect(analyzeSegments(`a${NBSP}b`).encoding).toBe("ucs2");
  });

  it("backtick and tab are not GSM-7", () => {
    expect(analyzeSegments("`code`").encoding).toBe("ucs2");
    expect(analyzeSegments("a\tb").encoding).toBe("ucs2");
  });

  it("CR and LF are GSM-7", () => {
    expect(analyzeSegments("line1\r\nline2").encoding).toBe("gsm7");
  });
});

describe("septet counting (GSM-7)", () => {
  it("basic chars cost 1 septet", () => {
    expect(analyzeSegments("abc").units).toBe(3);
  });

  it.each(["\f", "^", "{", "}", "\\", "[", "]", "~", "|", "€"])(
    "extension char %j costs 2 septets",
    (ch) => {
      const r = analyzeSegments(ch);
      expect(r.encoding).toBe("gsm7");
      expect(r.units).toBe(2);
      expect(r.extensionChars).toEqual([ch]);
    },
  );

  it("mixed: 'a[b]' = 1 + 2 + 1 + 2 = 6 septets", () => {
    const r = analyzeSegments("a[b]");
    expect(r.units).toBe(6);
    expect(r.extensionChars).toEqual(["[", "]"]);
  });
});

describe("UTF-16 unit counting (UCS-2)", () => {
  it("BMP chars cost 1 unit each", () => {
    // é is GSM; the NBSP is what forces UCS-2. 6 code units total.
    const r = analyzeSegments(`héllo${NBSP}`);
    expect(r.encoding).toBe("ucs2");
    expect(r.units).toBe(6);
  });

  it("astral emoji costs 2 units", () => {
    const r = analyzeSegments("\u{1F600}");
    expect(r.units).toBe(2);
    expect(r.chars).toBe(1); // one code point
  });

  it("ZWJ family emoji counts every unit (4 emoji x2 + 3 ZWJ = 11)", () => {
    const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`;
    const r = analyzeSegments(family);
    expect(r.units).toBe(11);
    expect(r.chars).toBe(7);
  });

  it("flag emoji is 4 units (two regional indicators)", () => {
    expect(analyzeSegments("\u{1F1FA}\u{1F1F8}").units).toBe(4);
  });

  it("skin-tone modifier adds 2 units (thumbs up + medium = 4)", () => {
    expect(analyzeSegments("\u{1F44D}\u{1F3FD}").units).toBe(4);
  });

  it("variation selector and combining marks count as units", () => {
    // U+2764 + VS16 = 2 units
    expect(analyzeSegments("❤️").units).toBe(2);
    // e + combining acute + NBSP = 3 units
    expect(analyzeSegments(`e\u0301${NBSP}`).units).toBe(3);
  });
});

describe("single-segment boundaries", () => {
  it("160 GSM septets = 1 segment", () => {
    const r = analyzeSegments("a".repeat(160));
    expect(r.segments).toBe(1);
    expect(r.perSegment).toEqual([160]);
  });

  it("161 GSM septets = 2 segments (153 + 8)", () => {
    const r = analyzeSegments("a".repeat(161));
    expect(r.segments).toBe(2);
    expect(r.perSegment).toEqual([153, 8]);
  });

  it("80 € = 160 septets = 1 segment; 81 € = 2 segments", () => {
    expect(analyzeSegments("€".repeat(80)).segments).toBe(1);
    const r = analyzeSegments("€".repeat(81));
    expect(r.segments).toBe(2);
    // 76 € fit in a 153-septet part (152 septets; the 77th needs 2)
    expect(r.perSegment).toEqual([152, 10]);
  });

  it("70 UCS-2 units = 1 segment; 71 = 2 segments (67 + 4)", () => {
    const base = NBSP + "a".repeat(69); // NBSP forces ucs2, 70 units total
    expect(analyzeSegments(base).segments).toBe(1);
    const r = analyzeSegments(base + "b");
    expect(r.segments).toBe(2);
    expect(r.perSegment).toEqual([67, 4]);
  });

  it("35 astral emoji = 70 units = 1 segment; 36 = 2 segments", () => {
    expect(analyzeSegments("\u{1F600}".repeat(35)).segments).toBe(1);
    const r = analyzeSegments("\u{1F600}".repeat(36));
    expect(r.segments).toBe(2);
    // 33 emoji (66 units) fit in part 1; the 34th cannot split its pair
    expect(r.perSegment).toEqual([66, 6]);
  });
});

describe("placement-aware packing (naive ceil() is wrong)", () => {
  it("extension char never straddles a segment boundary", () => {
    // 152 a's + € + 150 a's + € = 306 septets. ceil(306/153) = 2,
    // but the escape pair cannot split: correct answer is 3 segments.
    const body = "a".repeat(152) + "€" + "a".repeat(150) + "€";
    const r = analyzeSegments(body);
    expect(r.units).toBe(306);
    expect(r.segments).toBe(3);
    expect(r.perSegment).toEqual([152, 152, 2]);
  });

  it("surrogate pair never straddles a segment boundary", () => {
    // 66 a's + emoji + 66 a's + emoji = 136 units, cap 67 per part.
    const body = "a".repeat(66) + "\u{1F600}" + "a".repeat(66) + "\u{1F600}";
    const r = analyzeSegments(body);
    expect(r.encoding).toBe("ucs2");
    expect(r.units).toBe(136);
    expect(r.perSegment).toEqual([66, 67, 3]);
    expect(r.segments).toBe(3);
  });

  it("perSegment always sums to units and respects capacity", () => {
    const bodies = [
      "a".repeat(500),
      "€".repeat(200),
      ("a".repeat(10) + "€").repeat(40),
      "\u{1F600}".repeat(100),
      "words and \u{1F389} mixed " + "a".repeat(300),
    ];
    for (const body of bodies) {
      const r = analyzeSegments(body);
      const cap =
        r.segments === 1
          ? r.encoding === "gsm7"
            ? 160
            : 70
          : r.encoding === "gsm7"
            ? 153
            : 67;
      expect(r.perSegment.reduce((s, n) => s + n, 0)).toBe(r.units);
      for (const part of r.perSegment) {
        expect(part).toBeGreaterThan(0);
        expect(part).toBeLessThanOrEqual(cap);
      }
      expect(r.perSegment.length).toBe(r.segments);
    }
  });
});

describe("degenerate input", () => {
  it("empty body: encoding none, zero everything", () => {
    const r = analyzeSegments("");
    expect(r).toMatchObject({ encoding: "none", units: 0, chars: 0, segments: 0 });
    expect(r.perSegment).toEqual([]);
  });

  it("lone surrogate does not throw and counts as 1 unit", () => {
    const r = analyzeSegments("\uD83D");
    expect(r.encoding).toBe("ucs2");
    expect(r.units).toBe(1);
  });

  it("nonGsmChars is deduplicated and capped at 10", () => {
    const twelveUnique =
      "ααββγγ" + // αβγ (lowercase Greek is not GSM)
      "ç’“”–—…ту"; // ç ’ “ ” – — … т у
    const r = analyzeSegments(twelveUnique);
    expect(new Set(r.nonGsmChars).size).toBe(r.nonGsmChars.length);
    expect(r.nonGsmChars.length).toBeLessThanOrEqual(10);
  });
});

describe("cross-checked vectors (Twilio segment calculator agreement)", () => {
  const vectors: [string, "gsm7" | "ucs2", number, number][] = [
    // [body, encoding, units, segments]
    ["Hello world", "gsm7", 11, 1],
    // 66 chars, 9 extension-char occurrences ({ } [ ] € ~ | | ^) = 75 septets
    ["Join us at the {party}! Bring [gifts] worth €20 ~ or more |maybe|^", "gsm7", 75, 1],
    // 74 BMP chars, all GSM except the two smart quotes = UCS-2, 2 segments
    [`I am 160 chars of pure GSM but with one sneaky ‘smart quote’ pushing units`, "ucs2", 74, 2],
    ["a".repeat(153 * 3), "gsm7", 459, 3],
    ["a".repeat(153 * 3 + 1), "gsm7", 460, 4],
    ["\u{1F600} party at 9", "ucs2", 13, 1],
  ];
  it.each(vectors)("%j -> %s, %d units, %d segments", (body, encoding, units, segments) => {
    const r = analyzeSegments(body);
    expect(r.encoding).toBe(encoding);
    expect(r.units).toBe(units);
    expect(r.segments).toBe(segments);
  });
});

describe("robustness (deterministic fuzz)", () => {
  it("never throws and holds invariants on arbitrary unicode", () => {
    // simple LCG so runs are reproducible without Date/Math.random
    let seed = 0x2f6e2b1;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    for (let i = 0; i < 200; i++) {
      const len = next() % 400;
      let s = "";
      for (let j = 0; j < len; j++) s += String.fromCharCode(next() % 0xffff);
      const r = analyzeSegments(s);
      expect(r.units).toBeGreaterThanOrEqual(0);
      expect(r.perSegment.reduce((a, b) => a + b, 0)).toBe(r.units);
      expect(r.perSegment.length).toBe(r.segments);
      if (s.length > 0) expect(r.segments).toBeGreaterThanOrEqual(1);
    }
  });
});
