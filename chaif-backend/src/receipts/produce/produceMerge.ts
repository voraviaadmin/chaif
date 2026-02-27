// src/receipts/produce/produceMerge.ts
// Vendor-agnostic semantic merging for multi-line produce.
// Runs BEFORE deterministic parse (inside receiptOcr central pipeline).

import { detectProduce } from "./produceDetector";

export type ProduceMergeResult = {
  lines: string[];
  mergedLineIndexes: number[]; // indexes in the OUTPUT array that were merged
};

const MONEY_ONLY_RE = /^-?\$?\d{1,7}(?:[.,]\d{2})-?\s*[A-Z]{0,2}\s*$/i;

function isMoneyOnlyLine(l: string): boolean {
  return MONEY_ONLY_RE.test((l ?? "").trim());
}

// A line that looks like produce detail even if total is missing
function looksLikeProduceDetail(line: string): boolean {
  const low = (line ?? "").toLowerCase();
  const hasUnit = /\b(lb|lbs|kg|g|oz|ea|ct|pc|pcs|each)\b/i.test(low);
  const hasWeight = /\b\d+(?:\.\d+)?\s*(lb|lbs|kg|g|oz)\b/i.test(low);
  const hasRateMarker = /@|\/\s*(lb|kg|g|oz)\b/i.test(low);
  const hasDigits = /\d/.test(low);
  return hasDigits && hasUnit && (hasWeight || hasRateMarker);
}

function hasLettersNoMoney(line: string): boolean {
  const l = (line ?? "").trim();
  if (!l) return false;
  const hasLetters = /[A-Za-z]/.test(l);
  const hasMoney = /-?\$?\d{1,7}(?:[.,]\d{2})-?/.test(l);
  return hasLetters && !hasMoney;
}

function joinClean(a: string, b: string): string {
  return `${(a ?? "").trim()} ${(b ?? "").trim()}`.replace(/\s{2,}/g, " ").trim();
}

export function mergeProduceLines(inputLines: string[]): ProduceMergeResult {
  const src = (inputLines ?? []).map((l) => (l ?? "").trim()).filter(Boolean);

  const out: string[] = [];
  const mergedIdx: number[] = [];

  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    const b = src[i + 1];
    const c = src[i + 2];

    // If A is a name-only line, and B looks like produce details → merge A+B
    if (a && b && hasLettersNoMoney(a) && looksLikeProduceDetail(b)) {
      // If B is missing a total but C is money-only, merge A+B+C
      if (c && isMoneyOnlyLine(c)) {
        const merged = joinClean(joinClean(a, b), c);
        out.push(merged);
        mergedIdx.push(out.length - 1);
        i += 2; // consumed A,B,C
        continue;
      }

      const merged = joinClean(a, b);
      out.push(merged);
      mergedIdx.push(out.length - 1);
      i += 1; // consumed A,B
      continue;
    }

    // If line itself already detects as produce, keep as-is
    // (We don't merge it with neighbors unless the above rule triggers.)
    out.push(a);
  }

  // Optional second pass: if detectProduce now succeeds on any merged line, great.
  // (No changes required; this is just acknowledging the output is ready.)

  return { lines: out, mergedLineIndexes: mergedIdx };
}