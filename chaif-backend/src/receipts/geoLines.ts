// geoLines.ts
// Centralized, vendor-agnostic "geometry → rows" builder for Google Vision DocumentTextDetection.
// Goals: privacy-friendly (no external calls here), plug-and-play, minimal vendor assumptions.

export type GeoVertex = { x?: number | null; y?: number | null };
export type GeoBBox = { vertices?: GeoVertex[] | null };

export type GeoWord = {
  text: string;
  bbox: GeoBBox;
  pageIndex: number;
  blockIndex: number;
  paraIndex: number;
  wordIndex: number;
  confidence?: number | null;
};

export type GeoLinesOptions = {
  /** How aggressively to merge words into the same row (multiplier on median word height). */
  yMergeMultiplier?: number; // default 0.65
  /** Drop "words" that are too small/empty (helps OCR noise). */
  minWordLen?: number; // default 1
  /** If true, collapses repeated spaces and trims each line. */
  normalizeWhitespace?: boolean; // default true
};

// Public, stable name used by callers (back-compat with earlier drafts)
export type GeoLineBuildOptions = GeoLinesOptions;


type LineBucket = {
  y: number; // running average of centerY
  words: Array<{ x: number; text: string }>;
};

export type GeoLineObj = {
  y: number;
  tokens: Array<{ x: number; text: string }>;
  text: string;
};

export function buildGeoLineObjects(wordsOrFullTextAnnotation: GeoWord[] | any, opts: GeoLineBuildOptions = {}): GeoLineObj[] {
  const yMergeMultiplier = opts.yMergeMultiplier ?? 0.65;
  const minWordLen = opts.minWordLen ?? 1;
  const normalizeWhitespace = opts.normalizeWhitespace ?? true;

  const words: GeoWord[] = Array.isArray(wordsOrFullTextAnnotation)
    ? wordsOrFullTextAnnotation
    : extractGeoWords(wordsOrFullTextAnnotation);

  const filtered = words.filter((w) => (w.text || "").length >= minWordLen);

  const enriched = filtered.map((w) => {
    const m = bboxToMetrics(w.bbox);
    return { ...w, _minX: m.minX, _cy: m.cy, _h: m.h };
  });

  const medH = median(enriched.map((e) => e._h).filter((h) => h > 0)) || 10;
  const yThresh = Math.max(3, medH * yMergeMultiplier);

  enriched.sort((a, b) => (a._cy - b._cy) || (a._minX - b._minX));

  const lines: Array<{ y: number; words: Array<{ x: number; text: string }> }> = [];

  for (const w of enriched) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = lines.length - 1; i >= 0; i--) {
      const dist = Math.abs(lines[i].y - w._cy);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      if (lines[i].y < w._cy - (yThresh * 2)) break;
    }

    if (bestIdx >= 0 && bestDist <= yThresh) {
      const L = lines[bestIdx];
      L.y = (L.y + w._cy) / 2;
      L.words.push({ x: w._minX, text: w.text });
    } else {
      lines.push({ y: w._cy, words: [{ x: w._minX, text: w.text }] });
    }
  }

  return lines.map((L) => {
    L.words.sort((a, b) => a.x - b.x);
    const s = L.words.map((w) => w.text).join(" ");
    const text = normalizeWhitespace ? normalizeLine(s) : s;
    return { y: L.y, tokens: L.words, text };
  }).filter((x) => x.text);
}

function clampNumber(n: any, fallback = 0): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function bboxToMetrics(bbox?: GeoBBox | null) {
  const verts = bbox?.vertices || [];
  const xs = verts.map((v) => clampNumber(v?.x, 0));
  const ys = verts.map((v) => clampNumber(v?.y, 0));
  if (!xs.length || !ys.length) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, cx: 0, cy: 0, h: 0 };
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const h = Math.max(0, maxY - minY);
  return { minX, maxX, minY, maxY, cx, cy, h };
}

function median(nums: number[]): number {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function normalizeLine(s: string) {
  return s.replace(/\s{2,}/g, " ").trim();
}

/**
 * Extract GeoWords from Google Vision's `fullTextAnnotation`.
 * Works with DocumentTextDetection output.
 */
export function extractGeoWords(fullTextAnnotation: any): GeoWord[] {
  const out: GeoWord[] = [];
  const pages = fullTextAnnotation?.pages || [];
  for (let p = 0; p < pages.length; p++) {
    const blocks = pages[p]?.blocks || [];
    for (let b = 0; b < blocks.length; b++) {
      const paras = blocks[b]?.paragraphs || [];
      for (let pa = 0; pa < paras.length; pa++) {
        const words = paras[pa]?.words || [];
        for (let w = 0; w < words.length; w++) {
          const syms = words[w]?.symbols || [];
          const text = syms.map((s: any) => s?.text ?? "").join("");
          const cleaned = String(text ?? "").trim();
          const confidence = clampNumber(words[w]?.confidence, NaN);
          out.push({
            text: cleaned,
            bbox: words[w]?.boundingBox,
            pageIndex: p,
            blockIndex: b,
            paraIndex: pa,
            wordIndex: w,
            confidence: Number.isFinite(confidence) ? confidence : null,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Build row-like strings from geometry.
 * This is intentionally vendor-agnostic; vendors can still apply preprocess rules afterward.
 */
//export function buildGeoLines(words: GeoWord[], opts: GeoLinesOptions = {}): string[] {
/**
 * Build row-like strings from geometry.
 * Accepts either GeoWord[] (already extracted) or a Vision fullTextAnnotation object.
 */
export function buildGeoLines(wordsOrFullTextAnnotation: GeoWord[] | any, opts: GeoLineBuildOptions = {}): string[] {
  return buildGeoLineObjects(wordsOrFullTextAnnotation, opts).map((o) => o.text);
}