// src/receipts/produce/produceDetector.ts
// Vendor-agnostic produce detection + structured extraction + confidence scoring.
// Pure functions. No OCR-provider assumptions.

export type ProduceUnit = "lb" | "kg" | "g" | "oz" | "ea" | "ct" | "pc";

export type ProduceMeta = {
  isProduce: true;
  weight?: number;
  unit?: ProduceUnit;
  unitPrice?: number;
  lineTotal?: number;

  // Extra outputs used for stable parsing:
  namePart?: string;          // cleaned description portion (tail removed)
  confidenceScore: number;    // 0..1
  reason?: string;            // short reason string
  mathValidated?: boolean;    // weight*unitPrice approx equals lineTotal
};

const UNIT_ALIASES: Record<string, ProduceUnit> = {
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",

  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",

  g: "g",
  gram: "g",
  grams: "g",

  oz: "oz",
  ounce: "oz",
  ounces: "oz",

  ea: "ea",
  each: "ea",

  ct: "ct",
  count: "ct",

  pc: "pc",
  pcs: "pc",
  piece: "pc",
  pieces: "pc",
};

function normalizeUnit(raw: string | undefined | null): ProduceUnit | undefined {
  if (!raw) return undefined;
  const key = String(raw).toLowerCase().replace(/\./g, "").trim();
  return UNIT_ALIASES[key];
}

function parseNum(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/[$,]/g, "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// money tokens like 1.64 or $1.64 or 3.00- (discount style)
// We treat trailing "-" as negative (rare for produce but safe).
const MONEY_TOKEN_RE = /-?\$?\d{1,7}(?:[.,]\d{2})-?/g;

// capture the *last* money token
function lastMoneyToken(line: string): { token: string; value: number } | null {
  const m = line.match(MONEY_TOKEN_RE);
  if (!m?.length) return null;
  const token = m[m.length - 1];
  let t = token.replace(/\$/g, "").replace(/,/g, "").trim();
  let neg = false;
  if (t.endsWith("-")) {
    neg = true;
    t = t.slice(0, -1);
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return { token, value: neg ? -n : n };
}

// Heuristic: produce details often contain:
// - a weight + unit (3.04 lb)
// - a rate marker (@) OR slash pricing (/lb) OR both
// - and a line total (last money token)
function hasProduceSignals(line: string): boolean {
  const low = line.toLowerCase();
  const hasUnit = /\b(lb|lbs|kg|g|oz|ea|ct|pc|pcs|each)\b/i.test(low);
  const hasWeightDecimal = /\b\d+(?:\.\d+)?\s*(lb|lbs|kg|g|oz)\b/i.test(low);
  const hasAtOrSlash = /@|\/\s*(lb|kg|g|oz)\b/i.test(low);
  return (hasUnit && hasAtOrSlash) || (hasWeightDecimal && (hasAtOrSlash || /\b@\b/.test(low)));
}

function approxEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

export type ProduceDetectOptions = {
  tolerance?: number; // absolute dollars tolerance (e.g., 0.02)
};

export function detectProduce(lineRaw: string, opts?: ProduceDetectOptions): ProduceMeta | null {
  const line = (lineRaw ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;

  // Must have some produce signals; keeps false positives low.
  if (!hasProduceSignals(line)) return null;

  // Extract lineTotal (must exist for high-confidence parsing)
  const last = lastMoneyToken(line);
  const lineTotal = last?.value;

  // Weight + unit: "3.04 lb", "2.62 Lbs"
  const weightUnitMatch = line.match(/\b(\d+(?:\.\d+)?)\s*(lb|lbs|kg|g|oz|ea|ct|pc|pcs|each)\b/i);
  const weight = parseNum(weightUnitMatch?.[1]);
  const unit = normalizeUnit(weightUnitMatch?.[2]);

  // Unit price patterns:
  //  - "@ 0.54"
  //  - "@ 0.69/LB"
  //  - "@ 1 / 0.50"  (HEB pattern)
  //  - "0.69/LB"     (sometimes no '@' but slash exists)
  let unitPrice: number | undefined;

  // Prefer explicit "@ ... price" forms first
  // 1) "@ 1 / 0.50" or "@ 1/0.50"
  let m = line.match(/@\s*\d+(?:\.\d+)?\s*\/\s*\$?(\d+(?:\.\d{2})?)\b/i);
  if (m?.[1]) unitPrice = parseNum(m[1]);

  // 2) "@ 0.54" or "@ $0.54"
  if (unitPrice === undefined) {
    m = line.match(/@\s*\$?(\d+(?:\.\d{2})?)\b/i);
    if (m?.[1]) unitPrice = parseNum(m[1]);
  }

  // 3) "0.69/LB" (possibly with $)
  if (unitPrice === undefined) {
    m = line.match(/\$?(\d+(?:\.\d{2})?)\s*\/\s*(lb|lbs|kg|g|oz)\b/i);
    if (m?.[1]) unitPrice = parseNum(m[1]);
  }

  // Build namePart by removing trailing produce details (best-effort).
  // If we can locate the weight token, we cut from there.
  let namePart: string | undefined;
  if (weightUnitMatch?.index !== undefined) {
    const cut = weightUnitMatch.index;
    namePart = line.slice(0, cut).trim();
    // If we accidentally left a dangling "@", etc, trim again.
    namePart = namePart.replace(/[@\-\s]+$/g, "").trim();
  } else {
    // Fallback: remove last money token and any trailing markers
    if (last?.token) {
      const idx = line.lastIndexOf(last.token);
      if (idx >= 0) namePart = line.slice(0, idx).trim();
    }
  }

  // Confidence scoring
  const tol = Number.isFinite(opts?.tolerance) ? (opts!.tolerance as number) : 0.02;

  const hasAll = weight !== undefined && !!unit && unitPrice !== undefined && lineTotal !== undefined;
  let mathValidated = false;
  if (hasAll) {
    const expected = (weight as number) * (unitPrice as number);
    mathValidated = approxEqual(expected, lineTotal as number, Math.max(tol, 0.02));
  }

  let confidence = 0.0;
  const missing: string[] = [];

  if (weight !== undefined && unit) confidence += 0.35; else missing.push("weight");
  if (unitPrice !== undefined) confidence += 0.35; else missing.push("unitPrice");
  if (lineTotal !== undefined) confidence += 0.2; else missing.push("lineTotal");
  if (namePart && /[A-Za-z]/.test(namePart)) confidence += 0.1; else missing.push("name");

  if (hasAll && mathValidated) confidence = Math.min(1.0, confidence + 0.15);
  if (hasAll && !mathValidated) confidence = Math.max(0.2, confidence - 0.15);

  const reason =
    hasAll
      ? (mathValidated ? "produce:full+mathOK" : "produce:full+mathMismatch")
      : `produce:partial missing=${missing.join(",")}`;

  return {
    isProduce: true,
    weight,
    unit,
    unitPrice,
    lineTotal,
    namePart: namePart || undefined,
    confidenceScore: Math.max(0, Math.min(1, confidence)),
    reason,
    mathValidated,
  };
}