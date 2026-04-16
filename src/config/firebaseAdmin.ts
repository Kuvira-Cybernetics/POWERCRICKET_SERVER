/**
 * Firebase Admin SDK initialization.
 *
 * Credentials are loaded from ONE of:
 *   1. GOOGLE_APPLICATION_CREDENTIALS env var (path to JSON key file) — standard GCP pattern
 *   2. FIREBASE_SERVICE_ACCOUNT env var (inline JSON string) — Colyseus Cloud friendly
 *   3. Nothing — initFirebaseAdmin() returns undefined; callers fall back to defaults
 *
 * Firestore project defaults to powercricket-c5578 (matches client google-services.json).
 * Override with FIREBASE_PROJECT_ID env var if needed.
 */
import admin from "firebase-admin";

let _db: FirebaseFirestore.Firestore | undefined;
let _initAttempted = false;

/**
 * Initialize Firebase Admin and return a Firestore handle.
 * Safe to call multiple times — only inits once.
 * Returns undefined if credentials are not configured.
 */
export function initFirebaseAdmin(): FirebaseFirestore.Firestore | undefined {
    if (_initAttempted) return _db;
    _initAttempted = true;

    try {
        // Pick credentials source
        let credential: admin.credential.Credential | undefined;

        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            credential = admin.credential.cert(json);
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            // Admin SDK reads GOOGLE_APPLICATION_CREDENTIALS automatically via applicationDefault()
            credential = admin.credential.applicationDefault();
        } else {
            console.warn("[FirebaseAdmin] No credentials configured — Firestore disabled. " +
                "Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS.");
            return undefined;
        }

        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential,
                projectId: process.env.FIREBASE_PROJECT_ID || "powercricket-c5578",
            });
        }

        _db = admin.firestore();
        console.log(`[FirebaseAdmin] Initialized (project=${process.env.FIREBASE_PROJECT_ID || "powercricket-c5578"})`);
        return _db;
    } catch (err) {
        console.warn("[FirebaseAdmin] Initialization failed — running without Firestore:", err);
        return undefined;
    }
}

export function getDb(): FirebaseFirestore.Firestore | undefined {
    return _db;
}
