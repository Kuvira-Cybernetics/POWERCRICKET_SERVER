/**
 * Audit Firestore `powerDefinitions` and report each doc's image-data status.
 *
 * Why: TEST 7 surfaced `####_FALLBACK_POWER_ICON_MISSING` for `BoundaryLegend`,
 * `Confusion`, and `Googly` — Firestore power docs exist but lack
 * `powerImageBase64` / `powerImage`, so PowerData.Icon stays null and the
 * MatchPowerStrip falls back to the prefab default sprite.
 *
 * This script lists every power doc with: which image fields are populated,
 * b64 length if present, and whether the doc is missing image data entirely.
 *
 * Usage:
 *   tsx --env-file=.env scripts/audit-power-definitions.ts
 *
 * Flags:
 *   --missing-only   Only print docs that lack image data.
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

const COLLECTION = "powerDefinitions";

async function main() {
    const missingOnly = process.argv.includes("--missing-only");

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT (or use .env.development).");
        process.exit(1);
    }

    const snap = await db.collection(COLLECTION).get();
    if (snap.empty) {
        console.warn(`[audit-powers] ${COLLECTION} is empty. Seed via Unity admin tool.`);
        process.exit(0);
    }

    const rows: { id: string; name: string; b64Len: number; urlPresent: boolean }[] = [];
    snap.forEach(doc => {
        const d: any = doc.data() || {};
        const id   = (typeof d.powerId === "string" && d.powerId) || doc.id;
        const name = typeof d.powerName === "string" ? d.powerName : "(no name)";
        const b64  = typeof d.powerImageBase64 === "string" ? d.powerImageBase64 : "";
        const url  = typeof d.powerImage === "string" ? d.powerImage : "";
        rows.push({ id, name, b64Len: b64.length, urlPresent: url.length > 0 });
    });
    rows.sort((a, b) => a.id.localeCompare(b.id));

    let withImage = 0, missing = 0;
    console.log(`[audit-powers] ${rows.length} power docs in Firestore.\n`);
    console.log("ID                       NAME                          b64        URL");
    console.log("------------------------------------------------------------------------");
    for (const r of rows) {
        const hasImage = r.b64Len > 0 || r.urlPresent;
        if (missingOnly && hasImage) continue;
        const b64Col = r.b64Len > 0 ? `${r.b64Len}b`.padEnd(10) : "-".padEnd(10);
        const urlCol = r.urlPresent ? "yes" : "-";
        const flag   = hasImage ? "  " : "❌";
        console.log(`${flag}${r.id.padEnd(25)}${r.name.padEnd(30)}${b64Col} ${urlCol}`);
        if (hasImage) withImage++; else missing++;
    }
    console.log("------------------------------------------------------------------------");
    console.log(`Total: ${rows.length}   With image: ${withImage}   Missing image: ${missing}`);

    if (missing > 0) {
        console.log("\nNext step: open Unity admin tool, paste a base64 PNG into each missing doc's");
        console.log("`powerImageBase64` field (or set `powerImage` to a public URL).");
    }
    process.exit(0);
}

main().catch(err => {
    console.error("[audit-powers] Failed:", err);
    process.exit(1);
});
