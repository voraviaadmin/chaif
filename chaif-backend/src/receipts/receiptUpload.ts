import type { Request, Response } from "express";
import type { Express } from "express";
import crypto from "crypto";
import { extractReceipt } from "./receiptOcr";
import { tryExtractTextFromPdf } from "./receiptPdf";

function sha256(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function isSupportedMime(m: string) {
  return m === "application/pdf" || m === "image/jpeg" || m === "image/png" || m === "image/webp";
}

export const uploadReceiptHandler =
  (deps: {
    prisma: any;
    requireMember: (tx: any, req: any) => Promise<{ householdId: string }>;
    audit: (evt: any) => Promise<void>;
  }) =>
  async (req: Request, res: Response) => {
    try {
      const { prisma, requireMember, audit } = deps;

      // Resolve household context (dev override header)
      const headerHouseholdId =
        (req.headers["x-household-id"] as string | undefined) ||
        (req.headers["x-householdid"] as string | undefined);

      const allowOverride = String(process.env.ALLOW_HOUSEHOLD_OVERRIDE || "false").toLowerCase() === "true";

      let householdId: string | null = null;
      if (allowOverride && headerHouseholdId?.trim()) {
        householdId = headerHouseholdId.trim();
      } else {
        const ctx = await prisma.$transaction((tx: any) => requireMember(tx, req));
        householdId = ctx.householdId;
      }

      if (!householdId) return res.status(401).json({ error: "MISSING_householdId" });

      const f = (req as any).file as Express.Multer.File | undefined;
      if (!f?.buffer || !f?.mimetype) {
        return res.status(400).json({ error: "file is required (multipart field name: file)" });
      }

      if (!isSupportedMime(f.mimetype)) {
        return res.status(415).json({
          error: `Unsupported file type: ${f.mimetype}. Supported: pdf, jpg, png, webp`,
        });
      }

      // Optional overrides / traceability
      const sourceType = req.body?.sourceType ?? "upload";
      const sourceRef = req.body?.sourceRef ?? null;
      const currencyOverride = req.body?.currency ?? null;
      const vendorOverride = req.body?.vendor ?? null;

      // Idempotency
      const sourceHash = sha256(f.buffer);
      
      const existing = await prisma.receiptRaw.findFirst({
        where: { householdId, sourceHash, deletedAt: null },
        include: { lines: true },
      });
      if (existing) {
        return res.status(200).json({
          receipt: existing,
          ocr: { provider: "none", confidence: 1, needsReview: false },
          deduped: true,
        });
      }
    

      // Extract + parse
      const extracted = await extractReceipt({
        buffer: f.buffer,
        mimeType: f.mimetype,
        fileName: f.originalname,
      });

      const vendor = String(vendorOverride ?? extracted.receipt.vendor ?? "").trim();
      if (!vendor) {
        return res.status(422).json({
          error: "Could not determine vendor. Provide vendor in request body or use manual entry.",
          needsReview: true,
          extracted: { ...extracted, receipt: { ...extracted.receipt, vendor: null } },
        });
      }

      const storeRawText = String(process.env.RECEIPT_STORE_RAW_TEXT || "false").toLowerCase() === "true";
      const storeRawJson = String(process.env.RECEIPT_STORE_RAW_JSON || "false").toLowerCase() === "true";
      const purchaseDate = extracted.receipt.purchaseDate ? new Date(extracted.receipt.purchaseDate) : null;
      const status = extracted.needsReview ? "NEEDS_REVIEW" : "PARSED";

      const receipt = await prisma.receiptRaw.create({
        data: {
          householdId,
          vendor,
          purchaseDate,
          currency: currencyOverride ?? extracted.receipt.currency ?? null,
          sourceType,
          sourceRef,
          sourceHash,
          rawText: storeRawText ? (extracted.rawText ?? null) : null,
          rawJson: storeRawJson ? (extracted.rawJson ?? null) : null,
          status,
          lines: extracted.lines?.length
            ? {
                create: extracted.lines.map((l: any, idx: number) => ({
                  lineNumber: idx + 1,
                  rawLineText: l.rawLineText ?? null,
                  vendorSku: l.vendorSku ?? null,
                  barcode: l.barcode ?? null,
                  name: l.name ?? null,
                  description: l.description ?? null,
                  originalQuantity: l.originalQuantity != null ? String(l.originalQuantity) : null,
                  originalUnit: l.originalUnit ?? null,
                  unitPrice: l.unitPrice != null ? String(l.unitPrice) : null,
                  lineTotal: l.lineTotal != null ? String(l.lineTotal) : null,
                })),
              }
            : undefined,
        },
        include: { lines: true },
      });

      await audit({
        actorType: "USER",
        actorId: (req as any).user?.id ?? null,
        action: "RECEIPT_UPLOAD_OCR",
        entityType: "ReceiptRaw",
        entityId: receipt.id,
        householdId,
        after: {
          vendor: receipt.vendor,
          purchaseDate: receipt.purchaseDate,
          status: receipt.status,
          provider: extracted.provider,
          confidence: extracted.confidence,
          needsReview: extracted.needsReview,
        },
        req,
      });

      return res.status(201).json({
        receipt,
        ocr: {
          provider: extracted.provider,
          confidence: extracted.confidence,
          needsReview: extracted.needsReview,
        },
      });
    } catch (e: any) {
      const msg = e?.message ?? "Unknown error";
      const status =
        msg.includes("Unsupported file type") ? 415 :
        msg.includes("file is required") ? 400 :
        500;
      return res.status(status).json({ error: msg });
    }
  };

