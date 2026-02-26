// src/receipts/vendors/walmart.ts
import type { ReceiptVendorAdapter } from "../vendorAdapters";

const walmartHeaderRe =
  /(walmart|wal\*mart|save money|live better|mgr\.|st#|op#|te#|tr#|tc#|items sold)/i;

const barcodeOnlyRe = /^\s*\d{11,18}\s*$/; // UPC/EAN-ish lines
const multiSkuRe = /\b\d{11,14}\b/g;

// If a line contains multiple SKU tokens, split into multiple lines
function splitLineByMultipleSkus(line: string): string[] {
  const matches = line.match(multiSkuRe) ?? [];
  if (matches.length <= 1) return [line];

  const out: string[] = [];
  let cursor = 0;

  for (const sku of matches) {
    const idx = line.indexOf(sku, cursor);
    if (idx < 0) continue;
    const end = idx + sku.length;

    const seg = line.slice(cursor, end).trim();
    if (seg) out.push(seg);

    cursor = end;
  }

  const tail = line.slice(cursor).trim();
  if (tail && out.length) {
    out[out.length - 1] = `${out[out.length - 1]} ${tail}`.replace(/\s{2,}/g, " ").trim();
  }

  return out.length ? out : [line];
}

export const walmartAdapter: ReceiptVendorAdapter = {
  id: "walmart",

  detect: ({ headerText, fullText }) => {
    const h = headerText ?? "";
    const f = fullText ?? "";
    // Score higher if it appears in the header (more reliable)
    if (walmartHeaderRe.test(h)) return 5;
    if (walmartHeaderRe.test(f)) return 2;
    return 0;
  },

  preprocessRawLines(lines: string[]) {
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !walmartHeaderRe.test(l))
      .filter((l) => !barcodeOnlyRe.test(l));
  },

  preprocessLogicalLines(lines: string[]) {
    const out: string[] = [];
    for (const l of lines) {
      const parts = splitLineByMultipleSkus(l);
      for (const p of parts) out.push(p);
    }
    return out;
  },
};