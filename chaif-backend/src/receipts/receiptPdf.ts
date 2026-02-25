import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

// pdf-parse typing in TS can be annoying; this import works reliably with TS.
// If you have esModuleInterop=true, you can switch to: import pdfParse from "pdf-parse";
const pdfParse: any = require("pdf-parse");

const execFileAsync = promisify(execFile);

function tmpDir(prefix: string) {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `${prefix}-${id}`);
}

export function normalizeReceiptText(s: string) {
  return String(s ?? "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cheap “is it receipt-like?” check so we don’t parse random PDFs as receipts
export function looksLikeReceiptText(text: string) {
  const t = (text ?? "").toLowerCase();
  const hasMoney = /(?:\$?\d{1,7}[.,]\d{2})/.test(t);
  const hasSomeLines = (text ?? "").split("\n").length >= 8;
  const hasStoreHints = /(costco|walmart|target|kroger|orders|purchases|subtotal|total|tax)/.test(t);
  return hasMoney && hasSomeLines && hasStoreHints;
}

export async function tryExtractTextFromPdf(buffer: Buffer): Promise<string | null> {
  try {
    const data = await pdfParse(buffer);
    const text = normalizeReceiptText(data?.text ?? "");
    if (!text) return null;
    if (!looksLikeReceiptText(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Render PDF to PNG buffers using poppler (pdftoppm).
 * PRODUCTION NOTE:
 * - In Docker: apt-get install -y poppler-utils
 * - On mac: brew install poppler
 */
export async function renderPdfToPngBuffers(
  buffer: Buffer,
  opts?: { dpi?: number; maxPages?: number }
): Promise<Buffer[]> {
  const dpi = opts?.dpi ?? 300;
  const maxPages = opts?.maxPages ?? 3; // receipts are usually 1–2 pages; keep costs bounded

  const dir = tmpDir("receipt-pdf");
  await fs.mkdir(dir, { recursive: true });

  const inPath = path.join(dir, "in.pdf");
  const outPrefix = path.join(dir, "page");

  await fs.writeFile(inPath, buffer);

  // Render all pages, but we’ll only load up to maxPages.
  // pdftoppm outputs: page-1.png, page-2.png, ...
  await execFileAsync("pdftoppm", ["-png", "-r", String(dpi), inPath, outPrefix]);

  const files = (await fs.readdir(dir))
    .filter((f) => /^page-\d+\.png$/i.test(f))
    .sort((a, b) => {
      const ai = Number(a.match(/page-(\d+)\.png/i)?.[1] ?? 0);
      const bi = Number(b.match(/page-(\d+)\.png/i)?.[1] ?? 0);
      return ai - bi;
    })
    .slice(0, maxPages);

  const bufs: Buffer[] = [];
  for (const f of files) {
    bufs.push(await fs.readFile(path.join(dir, f)));
  }

  // best-effort cleanup
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return bufs;
}