/**
 * Seed / upsert the gameConfig/match Firestore document with default values.
 *
 * Run once before first deploy:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/seed-game-config.ts
 *   # or
 *   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}' npx tsx scripts/seed-game-config.ts
 *
 * Flags:
 *   --overwrite   Overwrite the doc even if it already exists (default: merge only missing fields)
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

const DEFAULTS = {
    oversPerMatch:          3,
    ballsPerOver:           6,
    superOverEnabled:       true,
    matchmakingTimeout:     30,
    botInjectionRate:       0.3,
    botCatchRate:           0.1,
    botWicketZoneFactor:    0.1,
    coinRewardWin:          50,
    coinRewardLoss:         15,
    xpRewardWin:            30,
    xpRewardLoss:           10,
    trophyRewardWin:        30,
    trophyRewardLoss:       -20,
    teamMaxSpinBowlers:     2,
    teamMinFastBowlers:     1,
    maxPowersPerPlayer:     3,
    disconnectGracePeriod:  30,
    matchTimerPerBall:      30,
    arrowSpeedMultiplier:   1.0,
};

async function main() {
    const overwrite = process.argv.includes("--overwrite");

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT.");
        process.exit(1);
    }

    const ref = db.collection("gameConfig").doc("match");
    const snap = await ref.get();

    if (snap.exists && !overwrite) {
        console.log("📄 gameConfig/match already exists. Merging only missing fields.");
        console.log("   Pass --overwrite to replace with defaults.");
        const existing = snap.data() || {};
        const merged: Record<string, any> = { ...DEFAULTS, ...existing };
        await ref.set(merged, { merge: true });
        console.log("✅ Merge complete. Missing fields filled with defaults.");
    } else {
        const payload = {
            ...DEFAULTS,
            updatedAt: new Date().toISOString(),
        };
        await ref.set(payload);
        console.log(`✅ Seeded gameConfig/match (${overwrite ? "overwritten" : "created"}).`);
    }

    console.log("\nCurrent document:");
    const final = await ref.get();
    console.log(JSON.stringify(final.data(), null, 2));
    process.exit(0);
}

main().catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
});
