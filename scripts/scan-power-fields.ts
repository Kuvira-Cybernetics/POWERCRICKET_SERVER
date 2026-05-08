import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

async function main() {
    const db = initFirebaseAdmin();
    if (!db) process.exit(1);

    const snap = await db.collection("powerDefinitions").get();
    const allFields = new Map<string, number>();
    const sampleValues = new Map<string, any>();

    snap.forEach(doc => {
        const d: any = doc.data();
        for (const [k, v] of Object.entries(d)) {
            allFields.set(k, (allFields.get(k) || 0) + 1);
            if (!sampleValues.has(k)) {
                if (typeof v === "string" && v.length > 60) sampleValues.set(k, `string[${v.length}]`);
                else sampleValues.set(k, v);
            }
        }
    });

    console.log(`${snap.size} power docs. Field summary:`);
    const sorted = [...allFields.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, count] of sorted) {
        const sample = sampleValues.get(k);
        const sampleStr = typeof sample === "object" ? JSON.stringify(sample).slice(0, 60) : String(sample);
        console.log(`  ${k.padEnd(30)} present_in=${count}/${snap.size}  sample=${sampleStr}`);
    }
    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
