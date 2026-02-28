export type ReviewReasonCode =
  | "LOW_CONFIDENCE"
  | "MISSING_VENDOR"
  | "TOO_FEW_LINES"
  | "MISSING_TOTAL"
  | "HAS_SUSPICIOUS_LINES"
  | "OCR_NEEDS_REVIEW";

export function computeNeedsReview(input: {
  vendor: string | null;
  confidence: number; // 0..1
  total: number | null;
  lines: Array<{
    rawLineText: string;
    name?: string | null;
    lineTotal?: number | null;
  }>;
}) {
  const reasonCodes: ReviewReasonCode[] = [];

  const vendor = (input.vendor ?? "").trim();
  if (!vendor) reasonCodes.push("MISSING_VENDOR");

  // Tuneable threshold (start conservative)
  if (Number.isFinite(input.confidence) && input.confidence < 0.65) {
    reasonCodes.push("LOW_CONFIDENCE");
  }

  const lineCount = input.lines?.length ?? 0;
  if (lineCount < 3) reasonCodes.push("TOO_FEW_LINES");

  // Only flag missing total if we got "enough" structure but total missing
  if (lineCount >= 3 && input.total == null) reasonCodes.push("MISSING_TOTAL");

  // Suspicious: lots of ultra-short lines or lines with no name-like content
  const suspicious = (() => {
    if (!input.lines || input.lines.length === 0) return true;

    let shortLines = 0;
    let namelessLines = 0;

    for (const l of input.lines) {
      const raw = String(l.rawLineText ?? "").trim();
      if (raw.length <= 2) shortLines++;

      const nm = String(l.name ?? "").trim();
      if (!nm) namelessLines++;
    }

    const shortRatio = shortLines / input.lines.length;
    const namelessRatio = namelessLines / input.lines.length;

    return shortRatio > 0.25 || namelessRatio > 0.6;
  })();

  if (suspicious) reasonCodes.push("HAS_SUSPICIOUS_LINES");

  return {
    needsReview: reasonCodes.length > 0,
    reasonCodes,
    confidenceScore: input.confidence,
  };
}