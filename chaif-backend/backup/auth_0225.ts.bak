// src/middleware/auth.ts
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "../prisma";
import type { AuthContext, SafeUser } from "../types";

const JWT_ISSUER = process.env.JWT_ISSUER!;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE!;
const JWKS_URI = process.env.JWKS_URI!;

if (!JWT_ISSUER || !JWT_AUDIENCE || !JWKS_URI) {
  throw new Error("Missing JWT_ISSUER, JWT_AUDIENCE, or JWKS_URI in .env");
}

const jwks = createRemoteJWKSet(new URL(JWKS_URI));

async function ensureUser(auth: AuthContext): Promise<SafeUser> {
  const authProvider = auth.provider;        // "voravia"
  const authSubject = auth.userId;           // sub

  return prisma.user.upsert({
    where: {
      authProvider_authSubject: { authProvider, authSubject },
    },
    update: {
      updatedAt: new Date(),
    },
    create: {
      authProvider,
      authSubject,
      // optional fields you can wire later (memberRef/email/displayName)
    },
    select: {
      id: true,
      authProvider: true,
      authSubject: true,
      memberRef: true,
      email: true,
      displayName: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function requireVoraviaJwt(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return res.status(401).json({ error: "UNAUTHENTICATED", message: "Missing bearer token" });
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const sub = payload.sub;
    if (!sub) {
      return res.status(401).json({ error: "UNAUTHENTICATED", message: "Token missing sub" });
    }

    req.auth = {
      provider: "voravia",
      userId: String(sub),
      issuer: String(payload.iss ?? JWT_ISSUER),
      audience: Array.isArray(payload.aud) ? String(payload.aud[0]) : String(payload.aud ?? JWT_AUDIENCE),
    };

    req.user = await ensureUser(req.auth);
    return next();
  } catch (err: any) {
    return res.status(401).json({
      error: "UNAUTHENTICATED",
      message: "Invalid token",
      detail: err?.code || err?.message || "unknown",
    });
  }
}
