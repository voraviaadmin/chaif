// ✅ Drop-in replacement: src/receiptOcr.ts
// Solves:
// 1) Costco line amounts not parsed (e.g., "12.99 Y", "3.00-", "10.49 N")
// 2) OCR split lines (desc on one line, price on next) => merges into one logical line
// 3) Vendor mis-detected as "Member" => prefers "Costco" / header-aware detection
// 4) OpenAI fallback non-JSON => robust JSON extraction + fallback never blocks upload
// 5) Google Vision auth via ADC (no API key) using @google-cloud/vision

import vision from "@google-cloud/vision";
import { tryExtractTextFromPdf, renderPdfToPngBuffers } from "./receiptPdf";
import { getVendorAdapter } from "./vendorAdapters";
import { buildGeoLines } from "./geoLines";
import { mergeProduceLines } from "./produce/produceMerge";
import { detectProduce } from "./produce/produceDetector";

//import * as pdfParse from "pdf-parse";

export type ReceiptOcrProviderName = "google" | "openai" | "pdf" | "none";

// --- OCR Provider Resolution (strict + centralized) ---

type OcrProvider = "google" | "openai" | "none";

function resolveOcrProvider(): OcrProvider {
    const raw = (process.env.RECEIPT_OCR_PROVIDER || "google").toLowerCase().trim();

    const allowed: OcrProvider[] = ["google", "openai", "none"];

    if (!allowed.includes(raw as OcrProvider)) {
        throw new Error(
            `[receiptOcr] Invalid RECEIPT_OCR_PROVIDER="${raw}". Allowed: ${allowed.join(", ")}`
        );
    }

    return raw as OcrProvider;
}

export type ReceiptOcrExtractResult = {
    receipt: {
        vendor: string | null;
        purchaseDate: string | null; // YYYY-MM-DD
        currency: string | null;
        total: number | null;
        tax: number | null;
    };
    lines: Array<{
        rawLineText: string;
        name?: string | null;
        description?: string | null;
        vendorSku?: string | null;
        barcode?: string | null;
        originalQuantity?: number | null;
        originalUnit?: string | null;
        unitPrice?: number | null;
        lineTotal?: number | null;
    }>;
    confidence: number;     // 0..1
    needsReview: boolean;
    provider: ReceiptOcrProviderName;
    rawJson?: any;
    rawText?: string | null;
};

const visionClient = new vision.ImageAnnotatorClient();

function env(name: string, fallback: string | null = null): string | null {
    const v = process.env[name];
    if (v === undefined || v === null) return fallback;
    const s = String(v).trim();
    return s.length ? s : fallback;
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function safeParseNumber(s: string): number | null {
    if (!s) return null;
  
    let raw = String(s).trim();
  
    // Handle parentheses negatives like "($3.00)"
    let neg = false;
    if (/^\(\s*.*\s*\)$/.test(raw)) {
      neg = true;
      raw = raw.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    }
  
    // Normalize unicode minus to hyphen-minus
    raw = raw.replace(/\u2212/g, "-");
  
    // keep digits, dot, comma, minus
    let cleaned = raw.replace(/[^0-9.,\-]/g, "").replace(/,/g, "");
    if (!cleaned) return null;
  
    // handle trailing minus like "2.40-" => "-2.40"
    if (cleaned.endsWith("-") && !cleaned.startsWith("-")) {
      cleaned = "-" + cleaned.slice(0, -1);
    }
  
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
  
    return neg ? -Math.abs(n) : n;
  }

function likelyCurrencyFromText(t: string): string | null {
    const up = t.toUpperCase();
    if (up.includes(" USD") || up.includes("$")) return "USD";
    if (up.includes(" CAD") || up.includes("C$")) return "CAD";
    if (up.includes(" EUR") || up.includes("€")) return "EUR";
    if (up.includes(" GBP") || up.includes("£")) return "GBP";
    return null;
}

function extractDate(text: string): string | null {
    const patterns: RegExp[] = [
        /\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/,
        /\b(0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])[-\/](20\d{2})\b/,
        /\b(0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])[-\/](\d{2})\b/,
    ];

    for (const re of patterns) {
        const m = text.match(re);
        if (!m) continue;

        if (re.source.startsWith("\\b(20")) {
            const yyyy = m[1];
            const mm = String(m[2]).padStart(2, "0");
            const dd = String(m[3]).padStart(2, "0");
            return `${yyyy}-${mm}-${dd}`;
        }

        if (m[3] && String(m[3]).length === 4) {
            const mm = String(m[1]).padStart(2, "0");
            const dd = String(m[2]).padStart(2, "0");
            const yyyy = m[3];
            return `${yyyy}-${mm}-${dd}`;
        }

        const mm = String(m[1]).padStart(2, "0");
        const dd = String(m[2]).padStart(2, "0");
        const yy = String(m[3]).padStart(2, "0");
        return `20${yy}-${mm}-${dd}`;
    }

    return null;
}

function scoreConfidence(opts: {
    hasVendor: boolean;
    hasDate: boolean;
    hasTotal: boolean;
    lineCount: number;
    pricedLineCount: number;
}): number {
    let score = 0;
    if (opts.hasVendor) score += 0.20;
    if (opts.hasDate) score += 0.20;
    if (opts.hasTotal) score += 0.25;
    score += Math.min(0.20, opts.lineCount / 40);

    const pricedRatio =
        opts.lineCount > 0 ? opts.pricedLineCount / opts.lineCount : 0;
    score += Math.min(0.15, pricedRatio * 0.25);

    return clamp01(score);
}

function extractFirstSku(line: string): string | null {
    const m = line.trim().match(/^(\d{5,8})\b/);
    return m ? m[1] : null;
}

function extractLastMoneyToken(line: string): string | null {
    const tokens = line.match(/-?\$?\d{1,7}(?:[.,]\d{2})-?/g);
    return tokens?.length ? tokens[tokens.length - 1] : null;
}

function stripMoneyAndMarker(line: string): string {
    // remove last money token + trailing marker letter(s)
    const m = extractLastMoneyToken(line);
    let out = line;
    if (m) {
        const idx = out.lastIndexOf(m);
        if (idx >= 0) out = (out.slice(0, idx) + out.slice(idx + m.length)).trim();
    }
    out = out.replace(/\s*(?:[A-Z]{1,2})\s*$/i, "").trim();
    return out;
}

function isPriceOnlyLine(line: string): boolean {
    return /^-?\$?\d{1,7}(?:[.,]\d{2})-?\s*[A-Z]?\s*$/.test(line.trim());
}


function normalizeReceiptText(s: string): string {
    return (s ?? "")
        .replace(/\r/g, "\n")
        .replace(/\u00A0/g, " ")     // NBSP
        .replace(/[ \t]+\n/g, "\n")  // trailing whitespace before newline
        .replace(/\n{3,}/g, "\n\n")  // collapse giant gaps
        .trim();
}

// Cheap “is this receipt-like?” heuristic
function looksLikeReceiptText(s: string): boolean {
    if (!s) return false;
    const hasMoney = /-?\$?\d{1,7}(?:[.,]\d{2})-?/.test(s);
    const hasSomeLines = s.split("\n").length >= 10;
    return hasMoney && hasSomeLines;
}

type OcrMode = "auto" | "text" | "geo";

function getOcrMode(): OcrMode {
    // ✅ Default to GEO for images/PDF renders; fallback to text if geoText is absent.
    const v = (process.env.RECEIPT_OCR_MODE || "geo").toLowerCase();
    if (v === "auto" || v === "text" || v === "geo") return v as OcrMode;
    return "geo";
}

function scoreReceiptText(text: string): number {
    // Heuristic scoring for mode selection (text vs geo-lines).
    // Rewards: money values, totals markers, UPC/SKU patterns.
    // Penalizes: URLs and extremely low structure.
    const t = (text || "").replace(/\r/g, "");
    if (!t.trim()) return -1e9;

    const lines = t
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);

    const moneyHits = (t.match(/\b\d{1,7}[.,]\d{2}\b/g) || []).length;
    const upcHits = (t.match(/\b\d{11,14}\b/g) || []).length;
    const skuHits = (t.match(/\b\d{4,7}\b/g) || []).length;
    const totalsHits = (t.match(/\b(subtotal|total|tax|change\s+due)\b/gi) || []).length;
    const urlHits = (t.match(/https?:\/\//gi) || []).length;
    const structure = Math.min(lines.length, 120);

    return moneyHits * 6 + upcHits * 4 + skuHits * 2 + totalsHits * 8 + structure * 0.5 - urlHits * 10;
}

function chooseOcrText(opts: {
    text: string;
    geoText?: string;
    mode: OcrMode;
}): { chosenText: string; chosenMode: "text" | "geo"; scores: { text: number; geo: number } } {
    const scoreText = scoreReceiptText(opts.text);
    const scoreGeo = opts.geoText ? scoreReceiptText(opts.geoText) : -1e9;

    if (opts.mode === "geo" && opts.geoText) {
        return { chosenText: opts.geoText, chosenMode: "geo", scores: { text: scoreText, geo: scoreGeo } };
    }
    if (opts.mode === "text") {
        return { chosenText: opts.text, chosenMode: "text", scores: { text: scoreText, geo: scoreGeo } };
    }

    // auto: require a margin so we don't destabilize known-good vendors.
    if (opts.geoText && scoreGeo > scoreText + 5) {
        return { chosenText: opts.geoText, chosenMode: "geo", scores: { text: scoreText, geo: scoreGeo } };
    }
    return { chosenText: opts.text, chosenMode: "text", scores: { text: scoreText, geo: scoreGeo } };
}

//const pdfParse = require("pdf-parse");



// ✅ Google Vision (SDK + ADC)
async function googleVisionDocument(buffer: Buffer): Promise<{ text: string; fullTextAnnotation?: any }> {
    const [result] = await visionClient.documentTextDetection({ image: { content: buffer } });
    return {
        text: result.fullTextAnnotation?.text ?? "",
        fullTextAnnotation: result.fullTextAnnotation,
    };
}

// ✅ Robust JSON extraction from OpenAI (handles fenced JSON / extra text)
function extractJsonFromText(s: string): any | null {
    const raw = String(s || "").trim();
    if (!raw) return null;

    // direct
    try {
        return JSON.parse(raw);
    } catch { }

    // fenced ```json ... ```
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch { }
    }

    // first {...} block
    const firstObj = raw.match(/\{[\s\S]*\}/);
    if (firstObj?.[0]) {
        try {
            return JSON.parse(firstObj[0]);
        } catch { }
    }

    return null;
}

async function openAiVisionExtract(
    buffer: Buffer,
    mimeType: string
): Promise<Omit<ReceiptOcrExtractResult, "provider">> {
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI fallback OCR");

    const prompt = [
        "Extract grocery receipt data.",
        "Return STRICT JSON only (no markdown, no prose).",
        "Schema:",
        "{ vendor, purchaseDate(YYYY-MM-DD or null), currency, total, tax, lines:[{rawLineText,name,originalQuantity,originalUnit,unitPrice,lineTotal}] }",
        "Rules:",
        "- include only purchasable line items (exclude subtotal/tax/total/payment)",
        "- preserve rawLineText as close as possible",
        "- numbers must be numeric (not strings) when present",
    ].join("\n");

    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

    const payload = {
        model: env("RECEIPT_OCR_OPENAI_MODEL", "gpt-4o-mini"),
        messages: [
            { role: "system", content: "Return JSON only." },
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: dataUrl } },
                ],
            },
        ],
        temperature: 0,
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`OpenAI fallback failed (${resp.status}): ${t?.slice(0, 300) ?? ""}`);
    }

    const json: any = await resp.json();
    const content = json?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonFromText(content);

    if (!parsed) throw new Error("OpenAI fallback returned non-JSON response");

    const receipt = parsed ?? {};
    const hasVendor = !!receipt.vendor;
    const hasDate = !!receipt.purchaseDate;
    const hasTotal = typeof receipt.total === "number";
    const lineCount = Array.isArray(receipt.lines) ? receipt.lines.length : 0;

    const confidence = scoreConfidence({
        hasVendor,
        hasDate,
        hasTotal,
        lineCount,
        pricedLineCount: Math.min(lineCount, Math.floor(lineCount * 0.8)),
    });

    const minConf = Number(env("RECEIPT_OCR_MIN_CONFIDENCE", "0.85"));
    const needsReview =
        confidence < (Number.isFinite(minConf) ? minConf : 0.85) ||
        lineCount < 3 ||
        !hasTotal;

    return {
        receipt: {
            vendor: receipt.vendor ?? null,
            purchaseDate: receipt.purchaseDate ?? null,
            currency: receipt.currency ?? null,
            total: typeof receipt.total === "number" ? receipt.total : null,
            tax: typeof receipt.tax === "number" ? receipt.tax : null,
        },
        lines: Array.isArray(receipt.lines)
            ? receipt.lines
                .filter((l: any) => l && typeof l.rawLineText === "string")
                .map((l: any) => ({
                    rawLineText: String(l.rawLineText),
                    name: l.name ?? null,
                    description: null,
                    vendorSku: null,
                    barcode: null,
                    originalQuantity: typeof l.originalQuantity === "number" ? l.originalQuantity : null,
                    originalUnit: l.originalUnit ?? null,
                    unitPrice: typeof l.unitPrice === "number" ? l.unitPrice : null,
                    lineTotal: typeof l.lineTotal === "number" ? l.lineTotal : null,
                }))
            : [],
        confidence,
        needsReview,
        rawText: null,
        rawJson: { provider: "openai", raw: receipt },
    };
}


function splitMultiSkuLines(lines: string[]): string[] {
    const skuRe = /\b\d{5,8}\b/g;
    const result: string[] = [];

    for (const line of lines) {
        const skus = [...line.matchAll(skuRe)];
        if (skus.length <= 1) {
            result.push(line);
            continue;
        }

        // More than one SKU in a single logical line → likely OCR merge
        // Split by SKU boundaries
        const parts = line.split(/(?=\b\d{5,8}\b)/g);

        for (const p of parts) {
            result.push(p.trim());
        }
    }

    return result;
}



function parseReceiptTextDeterministic(
    fullText: string
  ): Omit<ReceiptOcrExtractResult, "provider"> {
    const text = (fullText ?? "")
      .replace(/\r/g, "\n")
      .replace(/\u00A0/g, " ")
      .replace(/\u2212/g, "-"); // unicode minus → "-"
  
    // -----------------------
    // Raw lines (basic cleanup)
    // -----------------------
    let rawLines = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  
    rawLines = rawLines.filter((l) => {
      const low = l.toLowerCase();
      if (!/[A-Za-z0-9]/.test(l)) return false;
      if (low.includes("http://") || low.includes("https://") || low.includes("www.")) return false;
      if (/^\d+\s*\/\s*\d+$/.test(l.trim())) return false; // 1/2, 2/2
      return true;
    });
  
    // -----------------------
    // Vendor detection (keep)
    // -----------------------
    const header = rawLines.slice(0, Math.min(25, rawLines.length));
    const joinedHeader = header.join("\n").toLowerCase();
  
    const preferredVendors = ["costco", "walmart", "kroger", "target", "amazon", "whole foods", "heb", "aldi"];
    let vendor: string | null = null;
  
    for (const pv of preferredVendors) {
      if (joinedHeader.includes(pv)) {
        vendor = pv === "heb" ? "H-E-B" : pv.replace(/\b\w/g, (c) => c.toUpperCase());
        break;
      }
    }
  
    if (!vendor) {
      const ignore = ["welcome", "receipt", "thank you", "customer copy", "member", "orders & purchases"];
      for (let i = 0; i < Math.min(rawLines.length, 15); i++) {
        const l = rawLines[i];
        const low = l.toLowerCase();
        if (low.length < 2) continue;
        if (ignore.some((w) => low.includes(w))) continue;
        const letters = (l.match(/[A-Za-z]/g) ?? []).length;
        if (letters >= 3) {
          vendor = l;
          break;
        }
      }
    }
  
    const purchaseDate = extractDate(text);
    const currency = likelyCurrencyFromText(text);
  
    const adapter = getVendorAdapter(vendor);
    if (adapter?.preprocessRawLines) rawLines = adapter.preprocessRawLines(rawLines, { vendor });
  
    // -----------------------
    // Regex + helpers
    // -----------------------
    const totalsRe = /\b(subtotal|tax|total|amount due|balance due|change)\b/i;
    const tenderRe = /\b(visa|mastercard|amex|debit|credit)\b/i;
    const cashRe = /\bcash\b/i;
  
    // header-ish noise (generic)
    const headerNoiseRe =
      /\b(orders\s*&\s*purchases|member|approved|purchase|thank\s*you|customer\s*copy|order\s*summary|order\s*details|delivered|your\s*package\s+was\s+left|sold\s+by|supplied\s+by|return\s+items?)\b/i;
  
    // matches trailing money token + optional trailing minus + optional 1-3 letter flag
    function extractTailAmountAndFlag(line: string): { prefix: string; amount: string; flag: string } | null {
      const t = (line || "").trim();
      // Example matches:
      // "ONION ... 3.04" => prefix="ONION ...", amount="3.04"
      // "351935 /847909 4.00-" => prefix="351935 /847909", amount="4.00-"
      // "7.80-" => prefix="", amount="7.80-"
      const m = t.match(/^(.*?)(-?\$?\d{1,7}(?:[.,]\d{2})-?)(?:\s+([A-Z]{1,3}))?\s*$/);
      if (!m) return null;
      return { prefix: (m[1] || "").trim(), amount: (m[2] || "").trim(), flag: (m[3] || "").trim() };
    }
  
    function isPerUnitMoneyToken(line: string, tokenEndIndex: number): boolean {
      const tail = line.slice(tokenEndIndex, tokenEndIndex + 14).toLowerCase();
      return /^\s*\/\s*(lb|lbs|kg|g|oz|ea|ct|pc|pcs)\b/.test(tail);
    }
  
    // return BOTH the value and the exact token boundaries used so we can remove the correct token from name
    function pickLineTotalToken(line: string): { value: number; raw: string; start: number; end: number; perUnit: boolean } | null {
      const re = /-?\$?\d{1,7}(?:[.,]\d{2})-?/g;
      const hits: Array<{ value: number; raw: string; start: number; end: number; perUnit: boolean }> = [];
  
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const raw = m[0];
        const value = safeParseNumber(raw);
        if (value === null) continue;
        const start = m.index;
        const end = m.index + raw.length;
        const perUnit = isPerUnitMoneyToken(line, end);
        hits.push({ value, raw, start, end, perUnit });
      }
      if (!hits.length) return null;
  
      // prefer last NON-per-unit
      for (let i = hits.length - 1; i >= 0; i--) {
        if (!hits[i].perUnit) return hits[i];
      }
      return hits[hits.length - 1];
    }
  
    // recognize “discount ref rows” like "351935 /847909 4.00-"
    function isDiscountRefRow(line: string): boolean {
      const ex = extractTailAmountAndFlag(line);
      if (!ex) return false;
      const n = safeParseNumber(ex.amount);
      if (n === null || n >= 0) return false;
      // prefix contains no letters → looks like a reference row, not a product name
      return ex.prefix.length > 0 && !/[A-Za-z]/.test(ex.prefix);
    }
  
    // -----------------------
    // Logical stitching (FIXED)
    //
    // Key change vs your current approach:
    // - We DO NOT buffer arbitrary “no money” lines indefinitely.
    // - We only attach “likely continuation” lines (SKU/flags/weights) to the immediately previous item.
    // This prevents: first line being swallowed / dropped (HEB/F1).
    // -----------------------
    const logical: string[] = [];
    let pending: string | null = null;
  
    const looksLikeSkuOrCode = (l: string) => /^\d{5,13}\b/.test(l) || /^([A-Z]{1,2})\b/.test(l);
    const looksLikeWeightOrRate = (l: string) =>
      /\b\d+(?:\.\d+)?\s*(lb|lbs|kg|g|oz)\b/i.test(l) ||
      /@/.test(l) ||
      /\/\s*(lb|lbs|kg|g|oz)\b/i.test(l);
  
    const flush = () => {
      if (pending) {
        logical.push(pending.replace(/\s{2,}/g, " ").trim());
        pending = null;
      }
    };
  
    for (const l0 of rawLines) {
      const l = l0.trim();
      const low = l.toLowerCase();
  
      // keep these as standalone separators
      if (totalsRe.test(low) || tenderRe.test(low) || cashRe.test(low) || headerNoiseRe.test(low)) {
        flush();
        logical.push(l);
        continue;
      }
  
      // ✅ Always keep discount reference rows as standalone (we’ll normalize them in semantic repair)
      if (isDiscountRefRow(l)) {
        flush();
        logical.push(l);
        continue;
      }
  
      // If line has a usable trailing total token, it’s a complete row → flush pending and push
      const totalTok = pickLineTotalToken(l);
      if (totalTok && !totalTok.perUnit) {
        if (pending) {
          // attach pending (name) + this priced row
          logical.push(`${pending} ${l}`.replace(/\s{2,}/g, " ").trim());
          pending = null;
        } else {
          logical.push(l);
        }
        continue;
      }
  
      // If it’s a continuation line (SKU/weight/rate), attach to pending or last logical row
      if (looksLikeSkuOrCode(l) || looksLikeWeightOrRate(l)) {
        if (pending) {
          pending = `${pending} ${l}`.replace(/\s{2,}/g, " ").trim();
        } else if (logical.length) {
          logical[logical.length - 1] = `${logical[logical.length - 1]} ${l}`.replace(/\s{2,}/g, " ").trim();
        } else {
          pending = l;
        }
        continue;
      }
  
      // Otherwise this is a “name-like” line.
      // Start a new pending name; flush previous pending to avoid swallowing first item.
      if (pending) flush();
      pending = l;
    }
    flush();
  
    // -----------------------------
    // Semantic repair (FIXED negatives)
    // -----------------------------
    function semanticRepairLogicalLines(lines: string[]): string[] {
      const input = (lines || []).map((x) => (x ?? "").trim()).filter(Boolean);
      const out: string[] = [];
  
      for (let i = 0; i < input.length; i++) {
        const a = input[i];
  
        // Drop garbage token lines like "E E"
        if (/^([A-Z])(?:\s+\1)+$/.test(a.trim())) continue;
  
        // ✅ 1) Standalone negative lines like "7.80-"
        const ex = extractTailAmountAndFlag(a);
        if (ex) {
          const n = safeParseNumber(ex.amount);
          if (n !== null && n < 0) {
            // If it’s money-only, name it DISCOUNT
            if (!ex.prefix) {
              out.push(`DISCOUNT ${ex.amount}`.trim());
              continue;
            }
            // ✅ 2) Discount reference row: "351935 /847909 4.00-"
            // Prefix has no letters → treat as discount, preserve reference for audit trail
            if (!/[A-Za-z]/.test(ex.prefix)) {
              out.push(`DISCOUNT ${ex.prefix} ${ex.amount}`.replace(/\s{2,}/g, " ").trim());
              continue;
            }
          }
        }
  
        out.push(a);
      }
  
      return out;
    }
  
    let logicalFixed = splitMultiSkuLines(logical);
    if (adapter?.preprocessLogicalLines) logicalFixed = adapter.preprocessLogicalLines(logicalFixed, { vendor });
  
    // Produce merge (your module)
    const produceMerge = mergeProduceLines(logicalFixed);
    logicalFixed = produceMerge.lines;
    const produceMergedIdx = new Set<number>(produceMerge.mergedLineIndexes);
  
    logicalFixed = semanticRepairLogicalLines(logicalFixed);
  
    // -----------------------
    // Totals extraction (bottom scan)
    // -----------------------
    const moneyTokenRe = /-?\$?\d{1,7}(?:[.,]\d{2})-?/g;
  
    let total: number | null = null;
    let tax: number | null = null;
  
    const bottom = logicalFixed.slice(Math.max(0, logicalFixed.length - 60));
    for (let i = bottom.length - 1; i >= 0; i--) {
      const l = bottom[i];
      const low = l.toLowerCase();
  
      if (tax === null && /\btax\b/i.test(low)) {
        const all = l.match(moneyTokenRe);
        if (all?.length) tax = safeParseNumber(all[all.length - 1]) ?? tax;
      }
  
      if (total === null && /\b(total|amount due|balance due)\b/i.test(low)) {
        const all = l.match(moneyTokenRe);
        if (all?.length) {
          total = safeParseNumber(all[all.length - 1]) ?? total;
          if (total !== null) break;
        }
      }
    }
  
    // -----------------------
    // Item extraction
    // -----------------------
    const unitRe = /\b(oz|lb|lbs|g|kg|ml|l|ct|pk|pack|each)\b/i;
    const normalizeUnit = (u: string) => {
      const low = u.toLowerCase();
      if (low === "lbs") return "lb";
      if (low === "ct") return "each";
      if (low === "pk") return "pack";
      return low;
    };
  
    const discountHintRe = /\b(discount|savings|coupon|promo|instant\s+savings)\b/i;
  
    const items: any[] = [];
    let pricedLineCount = 0;
  
    for (let li = 0; li < logicalFixed.length; li++) {
      const l = logicalFixed[li];
      const low = l.toLowerCase();
      if (totalsRe.test(low) || tenderRe.test(low) || cashRe.test(low)) continue;
  
      const totalTok = pickLineTotalToken(l);
      const lineTotal = totalTok ? totalTok.value : null;
  
      const isDiscountish = discountHintRe.test(l) || /^discount\b/i.test(l);
  
      if (lineTotal === null) {
        if (!isDiscountish) continue;
      }
  
      pricedLineCount++;
  
      const produce = detectProduce(l, {
        tolerance: Number(env("RECEIPT_PRODUCE_TOLERANCE", "0.02")),
      });
  
      // ✅ remove the EXACT token we used for lineTotal (not always the last token)
      let noPrice = l.trim();
      if (totalTok) {
        noPrice = (noPrice.slice(0, totalTok.start) + noPrice.slice(totalTok.end)).trim();
      } else {
        // fallback: remove last money token
        const allMoney = l.match(moneyTokenRe);
        if (allMoney?.length) {
          const lastToken = allMoney[allMoney.length - 1];
          const idx = noPrice.lastIndexOf(lastToken);
          if (idx >= 0) noPrice = (noPrice.slice(0, idx) + noPrice.slice(idx + lastToken.length)).trim();
        }
      }
  
      noPrice = noPrice.replace(/\s*(?:[A-Z]{1,2})\s*$/i, "").trim(); // remove trailing Y/N/etc markers
      const noPricePreferred = produce?.namePart ? produce.namePart : noPrice;
  
      const skuMatch = noPricePreferred.match(/^(\d{5,8})\b\s*(.*)$/);
      const vendorSku = skuMatch ? skuMatch[1] : null;
      const nameRaw = (skuMatch ? (skuMatch[2] ?? "") : noPricePreferred).trim();
      let name = nameRaw.replace(/\s{2,}/g, " ").trim();
  
      // ✅ ensure discount rows don’t get dropped by empty name
      if (!name && /^discount\b/i.test(l)) name = "DISCOUNT";
      if (!name) continue;
  
      let originalQuantity: number | null = 1;
      let originalUnit: string | null = null;
  
      const unitMatch = name.match(unitRe);
      if (unitMatch?.[1]) originalUnit = normalizeUnit(unitMatch[1]);
  
      // Produce-aware unit price
      const unitPrice: number | null = produce?.unitPrice ?? lineTotal;
  
      items.push({
        rawLineText: l,
        name,
        description: null,
        vendorSku,
        barcode: null,
        originalQuantity,
        originalUnit,
        unitPrice,
        lineTotal,
        weight: produce?.weight ?? null,
        unit: produce?.unit ?? null,
        produceMeta: produce
          ? {
              confidenceScore: produce.confidenceScore,
              reason: produce.reason,
              mathValidated: produce.mathValidated,
              mergeApplied: produceMergedIdx.has(li),
            }
          : null,
      });
    }
  
    const finalItems = adapter?.postprocessItems ? adapter.postprocessItems(items, { vendor }) : items;
  
    const confidence = scoreConfidence({
      hasVendor: !!vendor,
      hasDate: !!purchaseDate,
      hasTotal: total !== null,
      lineCount: finalItems.length,
      pricedLineCount,
    });
  
    const minConf = Number(env("RECEIPT_OCR_MIN_CONFIDENCE", "0.85"));
    const needsReview =
      confidence < (Number.isFinite(minConf) ? minConf : 0.85) ||
      finalItems.length < 3 ||
      total === null;
  
    return {
      receipt: { vendor, purchaseDate, currency, total, tax },
      lines: finalItems,
      confidence,
      needsReview,
      rawText: fullText ?? null,
      rawJson: null,
    };
  }


export async function extractReceipt(file: {
    buffer: Buffer;
    mimeType: string;
    fileName?: string;
}): Promise<ReceiptOcrExtractResult> {
    //const providerRaw = String(env("RECEIPT_OCR_PROVIDER", "google") ?? "google");
    const providerRaw = process.env.RECEIPT_OCR_PROVIDER || "google";
    const fallbackRaw = String(env("RECEIPT_OCR_FALLBACK", "openai") ?? "openai");

    console.log("[receiptOcr] providerRaw bytes:", Buffer.from(providerRaw).toString("hex"));

    const normalizeProviderLoose = (v: string): ReceiptOcrProviderName => {
        const s = (v ?? "").toString().trim().toLowerCase();
        switch (s) {
            case "google":
            case "gcp":
            case "vision":
            case "googlevision":
            case "google-vision":
                return "google";
            case "openai":
            case "oai":
                return "openai";
            case "pdf":
                return "pdf";
            case "none":
            case "off":
            case "disabled":
                return "none";
            default:
                return "none";
        }
    };

    const normalizeProviderStrict = (v: string, envKey: string): ReceiptOcrProviderName => {
        const out = normalizeProviderLoose(v);
        // If user set *something* but it mapped to none, treat as invalid config.
        const raw = (v ?? "").toString().trim();
        if (raw.length > 0 && out === "none" && raw.toLowerCase() !== "none" && raw.toLowerCase() !== "off" && raw.toLowerCase() !== "disabled") {
            throw new Error(
                `[receiptOcr] Invalid ${envKey}="${raw}". Allowed: google|openai|pdf|none (aliases: gcp, vision, oai, off, disabled)`
            );
        }
        return out;
    };

    const provider = normalizeProviderStrict(providerRaw, "RECEIPT_OCR_PROVIDER");
    const fallback = normalizeProviderLoose(fallbackRaw); // fallback can safely disable itself

    console.log("[receiptOcr] providerNormalized =", provider);

    console.log("[receiptOcr] provider env =", process.env.RECEIPT_OCR_PROVIDER);
    console.log("[receiptOcr] file =", __filename);

    // ✅ PDF fast-path (embedded text → deterministic parsing)

    const mime = (file.mimeType || "").toLowerCase();

    if (mime.includes("pdf")) {
        // 1) Cheap path: embedded text
        const pdfText = await tryExtractTextFromPdf(file.buffer);
        if (pdfText) {
            const parsed = parseReceiptTextDeterministic(pdfText);
            return {
                ...parsed,
                provider: "pdf",
                rawJson: {
                    provider: "pdf",
                    mode: "pdf-text",
                    note: "Parsed from embedded PDF text (no OCR)",
                },
            };
        }

        // 2) Scanned/image-only PDF path: render pages -> OCR -> deterministic parse
        const dpi = Number(env("RECEIPT_PDF_DPI", "300"));
        const maxPages = Number(env("RECEIPT_PDF_MAX_PAGES", "3"));

        let pagePngs: Buffer[] = [];
        try {
            pagePngs = await renderPdfToPngBuffers(file.buffer, {
                dpi: Number.isFinite(dpi) ? dpi : 300,
                maxPages: Number.isFinite(maxPages) ? maxPages : 3,
            });
        } catch (e: any) {
            return {
                receipt: { vendor: null, purchaseDate: null, currency: null, total: null, tax: null },
                lines: [],
                confidence: 0,
                needsReview: true,
                rawText: null,
                rawJson: {
                    provider: "pdf",
                    mode: "pdf-render",
                    error: e?.message ?? "Failed to render PDF. Is poppler (pdftoppm) installed?",
                    note: "Install poppler-utils (pdftoppm) to enable scanned-PDF OCR.",
                },
                provider: "pdf",
            };
        }

        if (!pagePngs.length) {
            return {
                receipt: { vendor: null, purchaseDate: null, currency: null, total: null, tax: null },
                lines: [],
                confidence: 0,
                needsReview: true,
                rawText: null,
                rawJson: {
                    provider: "pdf",
                    mode: "pdf-render",
                    note: "Rendered 0 pages from PDF.",
                },
                provider: "pdf",
            };
        }

        // Force OCR provider selection (default google via env)
        if (provider === "google") {
            const mode = getOcrMode();
            console.log("[receiptOcr] mode env =", process.env.RECEIPT_OCR_MODE);
            console.log("[receiptOcr] mode normalized =", mode);
            const texts: string[] = [];
            for (const png of pagePngs) {
                const doc = await googleVisionDocument(png);
                const text = doc.text ?? "";
                const geoLines = doc.fullTextAnnotation ? buildGeoLines(doc.fullTextAnnotation) : null;
                const geoText = geoLines && geoLines.length ? geoLines.join("\n") : undefined;
                const picked = chooseOcrText({ text, geoText, mode });
                if (picked.chosenText) texts.push(picked.chosenText);
            }
            const fullText = texts.join("\n\n");
            const parsed = parseReceiptTextDeterministic(fullText);

            const result: ReceiptOcrExtractResult = {
                ...parsed,
                provider: "google",
                rawJson: {
                    provider: "google",
                    mode: "pdf-render+ocr",
                    pages: pagePngs.length,
                    ocrMode: mode,
                },
            };

            // Optional OpenAI header-only enrichment (same behavior you already use)
            if (result.needsReview && fallback === "openai") {
                try {
                    // Use first rendered page for enrichment (keeps cost bounded)
                    const fb = await openAiVisionExtract(pagePngs[0], "image/png");

                    result.receipt.vendor =
                        result.receipt.vendor && result.receipt.vendor.trim().length > 0
                            ? result.receipt.vendor
                            : fb.receipt.vendor;

                    result.receipt.purchaseDate =
                        result.receipt.purchaseDate ? result.receipt.purchaseDate : fb.receipt.purchaseDate;

                    result.receipt.currency =
                        result.receipt.currency ? result.receipt.currency : fb.receipt.currency;

                    const rt = result.receipt.total;
                    if (rt === null || rt === 0) result.receipt.total = fb.receipt.total;

                    if (result.receipt.tax === null) result.receipt.tax = fb.receipt.tax;

                    result.rawJson = {
                        ...(result.rawJson ?? {}),
                        enrichedBy: "openai-header",
                    };
                } catch {
                    // swallow fallback errors
                }
            }

            return result;
        }

        // If someone explicitly sets provider=openai for PDFs, keep behavior explicit
        if (provider === "openai") {
            // Use first page only (bounded cost)
            const fb = await openAiVisionExtract(pagePngs[0], "image/png");
            return {
                ...fb,
                provider: "openai",
                rawJson: {
                    provider: "openai",
                    mode: "pdf-render+openai",
                    pagesUsed: 1,
                },
            };
        }

        // provider=none (debug/manual)
        return {
            receipt: { vendor: null, purchaseDate: null, currency: null, total: null, tax: null },
            lines: [],
            confidence: 0,
            needsReview: true,
            provider: "none",
            rawJson: { provider: "none", mode: "pdf", note: "OCR disabled by config." },
            rawText: null,
        };
    }


    // ✅ Image receipts path (jpg/png/webp)
    if (mime.includes("jpeg") || mime.includes("jpg") || mime.includes("png") || mime.includes("webp")) {
        if (provider === "google") {
            const mode = getOcrMode();
            console.log("[receiptOcr] mode env =", process.env.RECEIPT_OCR_MODE);
            console.log("[receiptOcr] mode normalized =", mode);
            const doc = await googleVisionDocument(file.buffer);
            const text = doc.text ?? "";
            const geoLines = doc.fullTextAnnotation ? buildGeoLines(doc.fullTextAnnotation) : null;
            const geoText = geoLines && geoLines.length ? geoLines.join("\n") : undefined;
            const picked = chooseOcrText({ text, geoText, mode });
            console.log("[receiptOcr] pick", picked.chosenMode, picked.scores);

            const parsed = parseReceiptTextDeterministic(picked.chosenText);

            const result: ReceiptOcrExtractResult = {
                ...parsed,
                provider: "google",
                rawJson: {
                    provider: "google",
                    mode: "image-ocr",
                    ocrMode: picked.chosenMode,
                    ocrModeScores: picked.scores,
                },
            };

            // Optional OpenAI fallback (never blocks)
            if (result.needsReview && fallback === "openai") {
                try {
                    const fb = await openAiVisionExtract(file.buffer, file.mimeType);
                    // enrich only header fields (cheap)
                    result.receipt.vendor = result.receipt.vendor?.trim() ? result.receipt.vendor : fb.receipt.vendor;
                    result.receipt.purchaseDate = result.receipt.purchaseDate ?? fb.receipt.purchaseDate;
                    result.receipt.currency = result.receipt.currency ?? fb.receipt.currency;
                    if (result.receipt.total == null || result.receipt.total === 0) result.receipt.total = fb.receipt.total;
                    if (result.receipt.tax == null) result.receipt.tax = fb.receipt.tax;

                    result.rawJson = { ...(result.rawJson ?? {}), enrichedBy: "openai-header" };
                } catch {
                    // swallow fallback errors
                }
            }

            return result;
        }

        if (provider === "openai") {
            const fb = await openAiVisionExtract(file.buffer, file.mimeType);
            return {
                ...fb,
                provider: "openai",
                rawJson: { provider: "openai", mode: "image-openai" },
            };
        }

        // provider=none
        return {
            receipt: { vendor: null, purchaseDate: null, currency: null, total: null, tax: null },
            lines: [],
            confidence: 0,
            needsReview: true,
            provider: "none",
            rawJson: { provider: "none", mode: "image", note: "OCR disabled by config." },
            rawText: null,
        };
    }

    return {
        receipt: { vendor: null, purchaseDate: null, currency: null, total: null, tax: null },
        lines: [],
        confidence: 0,
        needsReview: true,
        provider: "none",
        rawJson: {
            provider: "none",
            error: `Unsupported RECEIPT_OCR_PROVIDER value: ${providerRaw}`,
        },
        rawText: null,
    };
}