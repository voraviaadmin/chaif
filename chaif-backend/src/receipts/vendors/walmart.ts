// src/receipts/vendors/walmart.ts
import type { ReceiptVendorAdapter } from "../vendorAdapters";

const walmartHeaderRe =
  /(walmart|wal\*mart|save money|live better|mgr\.|st#|op#|te#|tr#|tc#|items sold)/i;

const totalsNoiseRe =
  /^(subtotal|total|tax\b|change due|visa|credit|debit|tend|cash|balance|amount|return to previous page)$/i;

const barcodeOnlyRe = /^\s*\d{11,18}\s*$/; // UPC/EAN-ish lines
const multiSkuRe = /\b\d{11,14}\b/g;

const priceOnlyRe = /^\s*-?\d{1,7}(?:\.\d{2})\s*$/; // "7.92" or "-1.00"

// A common Walmart item line shape in PDFs:
// "<DESC...> <UPC> <FLAG> <PRICE>"
const upcFlagPriceRe = /^(.*)\s(\d{11,14})\s([A-Z])\s(-?\d{1,7}\.\d{2})$/;

// Strip prefix like: "2/25/26, 2:05 PM CEDAR PARK, TX "
// Keep the rest (which should start with item text)
function stripLeadingDateLocation(line: string): string {
  let s = line.trim();

  // Only attempt if it looks like it starts with a date
  if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return s;

  // Remove date/time
  s = s.replace(
    /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i,
    ""
  );

  // Remove "CITY, ST" (best-effort)
  s = s.replace(/^[A-Z .'-]+,\s*[A-Z]{2}\s*/i, "");

  return s.trim();
}

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
    out[out.length - 1] = `${out[out.length - 1]} ${tail}`
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return out.length ? out : [line];
}

function isTotalsNoise(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (totalsNoiseRe.test(l)) return true;
  if (/^(tax\s+\d+|\d+\s*%|0\s*%|subtotal|total)$/i.test(l)) return true;
  if (/^(visa|mastercard|amex|discover)\b/i.test(l)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}:\d{2}/.test(l)) return true; // timestamps footer
  return false;
}

export const walmartAdapter: ReceiptVendorAdapter = {
  id: "walmart",

  detect: ({ headerText, fullText }) => {
    const h = headerText ?? "";
    const f = fullText ?? "";
    if (walmartHeaderRe.test(h)) return 5;
    if (walmartHeaderRe.test(f)) return 2;
    return 0;
  },

  preprocessRawLines(lines: string[]) {
    return (lines || [])
      .map((l) => (l ?? "").trim())
      .filter(Boolean)
      .filter((l) => !walmartHeaderRe.test(l))
      .filter((l) => !barcodeOnlyRe.test(l));
  },

  preprocessLogicalLines(lines: string[]) {
    const input = (lines || [])
      .map((l) => stripLeadingDateLocation((l ?? "").trim()))
      .filter(Boolean)
      .filter((l) => !isTotalsNoise(l));

    const out: string[] = [];

    for (let i = 0; i < input.length; i++) {
      let line = input[i];
      const next = input[i + 1];

      // --- Walmart produce fix: lines with "/0.xx" are NOT a final amount.
      // Example:
      // ".... 000000004011 F 1.0 lb /0.54" then next line "1.64"
      // -> merge so the real lineTotal becomes 1.64 (and keep "/0.54" in text)
      if (next && priceOnlyRe.test(next) && /\/\s*\d+\.\d{2}\b/.test(line)) {
        const moneyRe = /-?\d+\.\d{2}/g;
        const nums = line.match(moneyRe) ?? [];

        // If the ONLY money on the line is the "/0.xx" rate, treat as missing final total
        const hasOnlyRate =
          nums.length === 1 && new RegExp(String.raw`/\s*${nums[0].replace(".", "\\.")}\b`).test(line);

        if (hasOnlyRate) {
          out.push(`${line} ${next.trim()}`.replace(/\s{2,}/g, " ").trim());
          i++; // consume next
          continue;
        }
      }

      // Split multi-UPC lines early
      const parts = splitLineByMultipleSkus(line);

      // If splitting happened, process parts individually (no lookahead swap)
      if (parts.length > 1) {
        for (const p of parts) out.push(p);
        continue;
      }

      // --- Special Walmart fix for YOUR receipt:
      // "STELLA ROSA COKE 004900004255 F 10.98" then "7.92"
      if (next && priceOnlyRe.test(next)) {
        const m = line.match(upcFlagPriceRe);
        if (m) {
          const prefix = (m[1] || "").trim(); // "STELLA ROSA COKE"
          const upc = m[2];
          const flag = m[3];
          const priceA = m[4]; // "10.98"
          const priceB = next.trim(); // "7.92"

          const words = prefix.split(/\s+/).filter(Boolean);
          if (words.length >= 2) {
            const lastWord = words.pop()!; // "COKE"
            const firstDesc = words.join(" "); // "STELLA ROSA"

            if (firstDesc) out.push(`${firstDesc} ${priceA}`.trim());
            out.push(`${lastWord} ${upc} ${flag} ${priceB}`.replace(/\s{2,}/g, " ").trim());

            i++; // consume next (price-only)
            continue;
          }
        }
      }

      // "000000004011 F 1.0 lb /0.54" then "1.64"
      if (
        next &&
        priceOnlyRe.test(next) &&
        /\b\d{11,14}\b/.test(line) &&
        !/\b\d{1,7}\.\d{2}\b/.test(line)
      ) {
        out.push(`${line} ${next.trim()}`.replace(/\s{2,}/g, " ").trim());
        i++; // consume next
        continue;
      }

      // "DONATION 4 AT 1 FOR 0.25" then "1.00"
      if (next && priceOnlyRe.test(next) && /^donation\b/i.test(line)) {
        out.push(`${line} ${next.trim()}`.replace(/\s{2,}/g, " ").trim());
        i++;
        continue;
      }

      // Default: emit
      out.push(line);
    }

    // ===========================
    // Post-pass fixes (safe, small)
    // ===========================

    // Fix OCR re-order where a stray item word gets inserted before another item's UPC
    // Example:
    //   "TROP OJ 89 BREAD 004850001829 F 8.12"
    //   "007087000200 F 2.97"
    // => move "BREAD" to next line:
    //   "TROP OJ 89 004850001829 F 8.12"
    //   "BREAD 007087000200 F 2.97"
    const skuPriceLineRe = /^(.*)\s(\d{11,14})\sF\s(-?\d+\.\d{2})$/;
    const startsWithSkuPriceRe = /^\d{11,14}\sF\s-?\d+\.\d{2}$/;

    for (let i = 0; i < out.length - 1; i++) {
      const m = out[i].match(skuPriceLineRe);
      if (!m) continue;

      const prefix = m[1].trim();
      const sku = m[2];
      const price = m[3];

      const words = prefix.split(/\s+/);
      if (words.length < 2) continue;

      const lastWord = words[words.length - 1];
      const prevWord = words[words.length - 2];

      if (/^[A-Z]{2,}$/.test(lastWord) && /\d$/.test(prevWord) && startsWithSkuPriceRe.test(out[i + 1])) {
        const newPrefix = words.slice(0, -1).join(" ");
        out[i] = `${newPrefix} ${sku} F ${price}`.replace(/\s{2,}/g, " ").trim();
        out[i + 1] = `${lastWord} ${out[i + 1]}`.replace(/\s{2,}/g, " ").trim();
      }
    }

    // Prevent subtotal leaking into donation like: "DONATION 1.00 75.83"
    const moneyRe = /-?\d+\.\d{2}/g;
    for (let i = 0; i < out.length; i++) {
      if (!/^donation\b/i.test(out[i])) continue;

      const nums = out[i].match(moneyRe);
      if (!nums || nums.length <= 1) continue;

      const first = nums[0]!; // safe because length > 1
      const idx = out[i].indexOf(first);
      if (idx >= 0) {
        out[i] = out[i].slice(0, idx + first.length).trim();
      }

    }

    return out;
  },
};