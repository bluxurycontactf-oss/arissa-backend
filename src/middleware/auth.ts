import { readFileSync } from "fs";
import type { NextFunction, Request, Response } from "express";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "../config.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string;
      userEmail?: string;
    }
  }
}

function ensureFirebaseApp() {
  if (getApps().length > 0) return;

  let serviceAccount: object | null = null;
  if (config.firebase.serviceAccountJson) {
    serviceAccount = JSON.parse(config.firebase.serviceAccountJson);
  } else if (config.firebase.serviceAccountPath) {
    serviceAccount = JSON.parse(readFileSync(config.firebase.serviceAccountPath, "utf-8"));
  }

  if (serviceAccount) initializeApp({ credential: cert(serviceAccount as Parameters<typeof cert>[0]) });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const configured = config.firebase.serviceAccountJson || config.firebase.serviceAccountPath;
  if (!configured) {
    return res.status(500).json({
      error:
        "Authentification non configurée. Ajoutez FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_SERVICE_ACCOUNT_PATH dans les variables d'environnement.",
    });
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentification requise." });
  }

  try {
    ensureFirebaseApp();
    const idToken = header.slice("Bearer ".length);
    const decoded = await getAuth().verifyIdToken(idToken);
    req.tenantId = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: "Token d'authentification invalide ou expiré." });
  }
}
