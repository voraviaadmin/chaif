// src/receipts/vendors/costco.ts
import type { ReceiptVendorAdapter, ParsedLineItem } from "../vendorAdapters";

const costcoRe = /\bcostco\b/i;

const markerOnlyRe = /^[A-Z]{1,2}$/; // E, F, etc
const startsWithSkuRe = /^\d{5,8}\b/; // Costco item number
const skuDescRe = /^\d{5,8}\s+[A-Z0-9].+/;
const skuOnlyOrShortDescRe = /^\d{5,8}\s+[A-Z]{2,5}$/;
const hasPriceSomewhereRe = /-?\$?\d{1,7}(?:[.,]\d{2})-?(?:\s*[A-Z])?\b/;
const priceOnlyRe = /^-?\$?\d{1,7}(?:[.,]\d{2})-?\s*[A-Z]?\s*$/;

function repairCostcoShiftedPrices(lines: string[]): string[] {
  // keep conservative; no-op for now
  return lines;
}

export const costcoAdapter: ReceiptVendorAdapter = {
  id: "costco",

  detect: ({ headerText, fullText }) => {
    if (costcoRe.test(headerText)) return 5;
    if (costcoRe.test(fullText)) return 2;
    return 0;
  },

  preprocessRawLines(rawLines: string[]) {
    return rawLines.filter((l) => !markerOnlyRe.test(l));
  },

  preprocessLogicalLines(logical: string[]) {
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
      if (
        next &&
        skuOnlyOrShortDescRe.test(l) &&
        hasPriceSomewhereRe.test(next) &&
        !startsWithSkuRe.test(next)
      ) {
        out.push(`${l} ${next}`.trim());
        i++;
        continue;
      }

      out.push(l);
    }

    return repairCostcoShiftedPrices(out);
  },

  postprocessItems(items: ParsedLineItem[]) {
    return items.map((it) => ({
      ...it,
      name: it.name.replace(/\s+[YNFE]\s*$/i, "").trim(),
    }));
  },
};