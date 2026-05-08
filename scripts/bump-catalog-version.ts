/**
 * Bump a counter on the central /gameVersions/catalog doc.
 *
 * Run this AFTER seeding new data via the Unity admin menu (or the web admin
 * tool). Clients compare server.<field>Version to their local PlayerPrefs
 * mirror at boot and only re-pull the dataset when the server is ahead.
 *
 * Pattern: IMPORTANT/Firestore_Data_Handling_Implementation.md.
 *
 * Usage:
 *   tsx --env-file=.env.development scripts/bump-catalog-version.ts <field>
 *   tsx --env-file=.env.development scripts/bump-catalog-version.ts all
 *
 * Fields:
 *   playerCardsVersion  bot profiles + player card definitions changed
 *   powersVersion       power definitions / images changed
 *   botProfilesVersion  bot profile JSON changed
 *   gameConfigVersion   gameConfig collection (incl. pattern_boxes_json) changed
 *   all                 bump every counter (use after a wholesale catalog re-seed)
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";
import { FieldValue } from "firebase-admin/firestore";

const COLLECTION = "gameVersions";
const DOC_ID     = "catalog";

const VALID_FIELDS = ["playerCardsVersion", "powersVersion", "botProfilesVersion", "gameConfigVersion", "all"];

async function main() {
    const arg = process.argv[2];
    if (!arg || !VALID_FIELDS.includes(arg)) {
        console.error(`Usage: bump-catalog-version.ts <${VALID_FIELDS.join("|")}>`);
        process.exit(1);
    }

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured.");
        process.exit(1);
    }

    const ref = db.collection(COLLECTION).doc(DOC_ID);
    const snap = await ref.get();
    const before: any = snap.exists ? snap.data() : {};
    const fieldsToBump = arg === "all"
        ? ["playerCardsVersion", "powersVersion", "botProfilesVersion", "gameConfigVersion"]
        : [arg];

    const update: Record<string, any> = { updatedAt: Date.now() };
    for (const f of fieldsToBump) {
        update[f] = FieldValue.increment(1);
    }

    await ref.set(update, { merge: true });

    const after = (await ref.get()).data() || {};
    console.log("[bump-catalog-version] Updated /gameVersions/catalog:");
    for (const f of ["playerCardsVersion", "powersVersion", "botProfilesVersion", "gameConfigVersion"]) {
        const fromV = before[f] ?? 0;
        const toV   = after[f] ?? 0;
        const arrow = fromV === toV ? "  " : "→";
        console.log(`  ${f.padEnd(22)} ${String(fromV).padStart(4)} ${arrow} ${toV}`);
    }
    console.log(`  updatedAt              ${after.updatedAt ?? 0}`);
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
