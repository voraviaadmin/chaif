// src/receipts/vendors/costco.ts
import type { VendorAdapter, ParsedLineItem } from "../vendorAdapters";

const markerOnlyRe = /^[A-Z]{1,2}$/;                // E, F, etc
const startsWithSkuRe = /^\d{5,8}\b/;               // Costco item number
const skuDescRe = /^\d{5,8}\s+[A-Z0-9].+/;          // SKU + some text
const skuOnlyOrShortDescRe = /^\d{5,8}\s+[A-Z]{2,5}$/; // e.g., "512515 ORG"
const hasPriceSomewhereRe = /-?\$?\d{1,7}(?:[.,]\d{2})-?(?:\s*[A-Z])?\b/;
const priceOnlyRe = /^-?\$?\d{1,7}(?:[.,]\d{2})-?\s*[A-Z]?\s*$/;

function repairCostcoShiftedPrices(lines: string[]): string[] {
  // Keep this conservative. Only “repair” when pattern is immediate adjacency.
  // If you already have a function, move it here unchanged.
  // Conservative default: do nothing.
  return lines;
}

export const costcoAdapter: VendorAdapter = {
  key: "Costco",
  applies: (vendor) => (vendor ?? "").toLowerCase().includes("costco"),

  preprocessRawLines: (rawLines) => {
    // Costco OCR often includes “E” marker lines; strip them early
    return rawLines.filter((l) => !markerOnlyRe.test(l));
  },

  preprocessLogicalLines: (logical) => {
    // OPTIONAL: keep Costco-specific line merge only if you still want it.
    // NOTE: Your current Costco merges are a major source of wrong attachments.
    // For now: do NOT do aggressive merges; only do very safe merges.

    const out: string[] = [];
    for (let i = 0; i < logical.length; i++) {
      const l = logical[i];
      const next = logical[i + 1];

      // Safe merge: SKU+DESC + immediate price-only line
      if (skuDescRe.test(l) && next && priceOnlyRe.test(next) && !startsWithSkuRe.test(next)) {
        out.push(`${l} ${next}`.trim());
        i++;
        continue;
      }

      // Safe merge: SKU + short token + next line has price and is not a new SKU
      if (next && skuOnlyOrShortDescRe.test(l) && hasPriceSomewhereRe.test(next) && !startsWithSkuRe.test(next)) {
        out.push(`${l} ${next}`.trim());
        i++;
        continue;
      }

      out.push(l);
    }

    return repairCostcoShiftedPrices(out);
  },

  postprocessItems: (items: ParsedLineItem[]) => {
    // Example: remove Costco trailing Y/N markers accidentally kept in names
    return items.map((it) => ({
      ...it,
      name: it.name.replace(/\s+[YNFE]\s*$/i, "").trim(),
    }));
  },
};