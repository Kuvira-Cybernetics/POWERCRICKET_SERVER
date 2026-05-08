import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

async function main() {
    const db = initFirebaseAdmin();
    if (!db) process.exit(1);

    const snap = await db.collection("playerCardDefinitions").get();
    const fieldCounts = new Map<string, number>();

    snap.forEach(doc => {
        const d: any = doc.data();
        for (const k of Object.keys(d)) {
            fieldCounts.set(k, (fieldCounts.get(k) || 0) + 1);
        }
    });

    console.log(`${snap.size} cards. Field summary:`);
    const sorted = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, count] of sorted) {
        console.log(`  ${k.padEnd(35)} present_in=${count}/${snap.size}`);
    }
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
