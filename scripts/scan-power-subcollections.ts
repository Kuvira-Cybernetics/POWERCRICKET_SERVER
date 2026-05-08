import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

async function main() {
    const db = initFirebaseAdmin();
    if (!db) process.exit(1);

    const snap = await db.collection("powerDefinitions").get();
    for (const doc of snap.docs) {
        const subs = await doc.ref.listCollections();
        if (subs.length > 0) {
            console.log(`${doc.id}: ${subs.length} subcollection(s)`);
            for (const s of subs) {
                const ssnap = await s.limit(3).get();
                console.log(`  ${s.id}  count_sample=${ssnap.size}  ids=[${ssnap.docs.map(d => d.id).join(",")}]`);
            }
        }
    }
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
