/**
 * List all top-level Firestore collections + first 3 doc IDs in each.
 *
 * Usage:
 *   tsx --env-file=.env.development scripts/list-collections.ts
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

async function main() {
    const db = initFirebaseAdmin();
    if (!db) { console.error("No Firebase creds."); process.exit(1); }

    const cols = await db.listCollections();
    if (cols.length === 0) { console.log("(no collections)"); process.exit(0); }

    console.log(`Top-level collections: ${cols.length}`);
    for (const c of cols) {
        const snap = await c.limit(3).get();
        const ids = snap.docs.map(d => d.id);
        const total = (await c.get()).size;
        console.log(`  ${c.id.padEnd(35)} count=${total}  sample=[${ids.join(", ")}]`);
    }
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
