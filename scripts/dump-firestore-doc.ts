/**
 * Dump a single Firestore doc for inspection.
 * Shows top-level field names + value types + lengths for string fields.
 *
 * Usage:
 *   tsx --env-file=.env.development scripts/dump-firestore-doc.ts <collection> <docId>
 *
 * Examples:
 *   tsx --env-file=.env.development scripts/dump-firestore-doc.ts playerCardDefinitions bat_rare_01
 *   tsx --env-file=.env.development scripts/dump-firestore-doc.ts powerDefinitions power_confusion
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

async function main() {
    const collection = process.argv[2];
    const docId      = process.argv[3];
    if (!collection || !docId) {
        console.error("Usage: dump-firestore-doc.ts <collection> <docId>");
        process.exit(1);
    }

    const db = initFirebaseAdmin();
    if (!db) { console.error("No Firebase creds."); process.exit(1); }

    const snap = await db.collection(collection).doc(docId).get();
    if (!snap.exists) { console.error(`${collection}/${docId} does not exist`); process.exit(2); }

    const d: any = snap.data();
    console.log(`${collection}/${docId}`);
    console.log("─".repeat(60));
    const keys = Object.keys(d).sort();
    for (const k of keys) {
        const v = d[k];
        let display: string;
        if (v == null) display = "(null)";
        else if (typeof v === "string") {
            if (v.length > 80) display = `string[${v.length}] = "${v.slice(0, 60)}..."`;
            else display = `"${v}"`;
        }
        else if (typeof v === "number" || typeof v === "boolean") display = String(v);
        else if (Array.isArray(v)) display = `array[${v.length}] = ${JSON.stringify(v).slice(0, 100)}`;
        else display = `object = ${JSON.stringify(v).slice(0, 100)}`;
        console.log(`  ${k.padEnd(30)} ${display}`);
    }
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
