/**
 * Rollback the 27 stub `playerCardDefinitions` docs created by
 * `seed-missing-player-cards.ts`. The stubs were created without the rich
 * data (role, rarity, powerIds, stats) that lives in the local .asset files,
 * and would shadow the real definitions when the client hydrates from Firestore.
 *
 * Stubs are detected by:
 *   - powerIds is empty array
 *   - playerName matches the prettified id pattern (e.g. "Bat Rare 05")
 *   - no powerImageBase64 / powerImage
 *   - no `speed`/`power`/`accuracy`/`special` (which the proper seeder writes)
 *
 * After rollback, run the proper Unity-side seeder
 * (PowerCricket > Seed Players to Firestore) which reads PlayerCardCatalog.asset
 * and uploads correct data.
 *
 * Usage:
 *   tsx --env-file=.env.development scripts/rollback-stub-player-cards.ts [--dry-run]
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

const COLLECTION = "playerCardDefinitions";

function expectedStubName(id: string): string {
    return id
        .split("_")
        .map(p => p.length === 0 ? p : p[0].toUpperCase() + p.slice(1))
        .join(" ");
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured.");
        process.exit(1);
    }

    const snap = await db.collection(COLLECTION).get();
    if (snap.empty) { console.log("Empty collection."); process.exit(0); }

    const stubs: string[] = [];
    snap.forEach(doc => {
        const d: any = doc.data() || {};
        const id = (typeof d.playerId === "string" && d.playerId) || doc.id;

        // Stub fingerprint: empty powerIds + name matches "Pretty Id" pattern + no stats.
        const powerIdsEmpty = !Array.isArray(d.powerIds) || d.powerIds.length === 0;
        const nameMatchesStub = d.playerName === expectedStubName(id);
        const noStats = (d.speed == null || d.speed === 0)
                     && (d.power == null || d.power === 0)
                     && (d.accuracy == null || d.accuracy === 0)
                     && (d.special == null || d.special === 0);
        const noImage = !d.powerImageBase64 && !d.powerImage;

        if (powerIdsEmpty && nameMatchesStub && noStats && noImage) {
            stubs.push(id);
        }
    });

    if (stubs.length === 0) {
        console.log("No stubs detected. Nothing to roll back.");
        process.exit(0);
    }

    console.log(`Detected ${stubs.length} stub doc(s):\n  ${stubs.join("\n  ")}`);

    if (dryRun) {
        console.log("--dry-run set; not deleting.");
        process.exit(0);
    }

    let deleted = 0;
    for (const id of stubs) {
        await db.collection(COLLECTION).doc(id).delete();
        console.log(`  ✅ deleted ${id}`);
        deleted++;
    }
    console.log(`Done. deleted=${deleted}`);
    console.log("\nNext step: run Unity menu 'PowerCricket > Seed Players to Firestore'");
    console.log("(requires Play Mode + Firebase initialized) to upload the rich");
    console.log("definitions from PlayerCardCatalog.asset.");
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
