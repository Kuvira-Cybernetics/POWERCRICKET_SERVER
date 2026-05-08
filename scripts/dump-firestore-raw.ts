/**
 * Raw JSON dump of a Firestore doc — no filtering, no pretty-printing.
 * Use to verify exactly what fields the doc has, including nested structures.
 *
 * Usage:
 *   tsx --env-file=.env.development scripts/dump-firestore-raw.ts <collection> <docId>
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

async function main() {
    const collection = process.argv[2];
    const docId      = process.argv[3];
    const db = initFirebaseAdmin();
    if (!db) { process.exit(1); }
    const snap = await db.collection(collection).doc(docId).get();
    if (!snap.exists) { console.error("not found"); process.exit(2); }
    console.log(JSON.stringify(snap.data(), (k, v) =>
        typeof v === "string" && v.length > 200 ? `<string ${v.length} chars>` : v, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
