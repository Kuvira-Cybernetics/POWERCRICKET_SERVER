/**
 * Seed bot-difficulty docs in the Firestore `gameConfig` collection.
 *
 * The admin site seeds all player-facing keys (match_overs, team_size, etc.).
 * Bot knobs are server-authoritative — NOT exposed in the admin UI — so this
 * script ensures the two private docs exist with defaults.
 *
 * Schema: doc-per-key.
 *   gameConfig/bot_catch_rate        → { key, value, label, description, type }
 *   gameConfig/bot_wicket_zone_factor → { key, value, label, description, type }
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/seed-game-config.ts
 *   # or
 *   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}' npx tsx scripts/seed-game-config.ts
 *
 * Flags:
 *   --overwrite   Overwrite docs that already exist (default: create only missing)
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

type ConfigDoc = {
    key: string;
    value: number;
    label: string;
    description: string;
    type: "number" | "boolean";
};

const BOT_DOCS: ConfigDoc[] = [
    {
        key: "bot_catch_rate",
        value: 0.1,
        label: "Bot Catch Rate",
        description: "Probability (0–1) that a bot successfully fields a 4/6. Server-only.",
        type: "number",
    },
    {
        key: "bot_wicket_zone_factor",
        value: 0.1,
        label: "Bot Wicket Zone Factor",
        description: "Multiplier (0–1) on wicket-zone weight when bot bowls. Server-only.",
        type: "number",
    },
];

async function main() {
    const overwrite = process.argv.includes("--overwrite");

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT.");
        process.exit(1);
    }

    let created = 0, skipped = 0, overwritten = 0;

    for (const doc of BOT_DOCS) {
        const ref = db.collection("gameConfig").doc(doc.key);
        const snap = await ref.get();

        if (snap.exists && !overwrite) {
            console.log(`📄 gameConfig/${doc.key} already exists — skipping (use --overwrite to replace).`);
            skipped++;
        } else if (snap.exists) {
            await ref.set(doc);
            console.log(`🔄 Overwrote gameConfig/${doc.key}.`);
            overwritten++;
        } else {
            await ref.set(doc);
            console.log(`✅ Created gameConfig/${doc.key}.`);
            created++;
        }
    }

    console.log(`\nDone. created=${created} overwritten=${overwritten} skipped=${skipped}`);
    process.exit(0);
}

main().catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
});
