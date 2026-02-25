// src/types.d.ts
import "express-serve-static-core";

export type AuthContext = {
  provider: "voravia";
  userId: string;   // JWT sub
  issuer: string;   // JWT iss
  audience: string; // JWT aud
};

export type SafeUser = {
  id: string;
  authProvider: string;
  authSubject: string;
  memberRef: string | null;
  email: string | null;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
    user?: SafeUser;
  }
}

export {};
