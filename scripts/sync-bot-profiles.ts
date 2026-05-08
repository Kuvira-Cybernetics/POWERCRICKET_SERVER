/**
 * Sync the bundled bot_profiles.json into Firestore `botProfiles`.
 *
 * The Unity admin window (Tools → Power Cricket → Bot Profiles) edits and
 * exports the JSON. This script reads the same JSON and writes it to Firestore
 * one doc per profile (docId = botProfileId). Server-side BotProfileLoader picks
 * Firestore over the bundled JSON automatically on next `initBotProfileLoader`
 * (also via the 5-min refresh tick).
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json npx tsx scripts/sync-bot-profiles.ts
 *   # or
 *   FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}' npx tsx scripts/sync-bot-profiles.ts
 *
 * Flags:
 *   --dry-run     Print what would be written; do not touch Firestore.
 *   --prune       Delete Firestore docs whose botProfileId isn't in the JSON.
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const COLLECTION = "botProfiles";

interface BotProfile {
    botProfileId:      string;
    displayName:       string;
    country:           string;
    avatarSpriteIndex: number;
    eloBand:           string;
    minElo:            number;
    maxElo:            number;
    playstyle:         string;
    bio:               string;
    fakeWinRecord:     string;
    battingPlayers:    string[];
    bowlingPlayers:    string[];
    isEnabled:         boolean;
}

function loadProfilesFromJson(): BotProfile[] {
    const here = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(here, "..", "src", "rooms", "bots", "bot_profiles.json");
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version: number; profiles: BotProfile[] };
    if (!parsed?.profiles?.length) {
        throw new Error(`No profiles found in ${jsonPath}`);
    }
    return parsed.profiles;
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const prune  = process.argv.includes("--prune");

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT.");
        process.exit(1);
    }

    const profiles = loadProfilesFromJson();
    console.log(`📂 Loaded ${profiles.length} profiles from JSON.`);

    let written = 0, pruned = 0;
    const jsonIds = new Set(profiles.map(p => p.botProfileId));

    for (const profile of profiles) {
        if (!profile.botProfileId) {
            console.warn("⚠️  Skipping profile with empty botProfileId:", profile);
            continue;
        }
        const ref = db.collection(COLLECTION).doc(profile.botProfileId);
        if (dryRun) {
            console.log(`🧪 (dry-run) would write ${COLLECTION}/${profile.botProfileId} (${profile.displayName} — ${profile.eloBand})`);
        } else {
            await ref.set(profile);
            console.log(`✅ Wrote ${COLLECTION}/${profile.botProfileId} (${profile.displayName} — ${profile.eloBand})`);
            written++;
        }
    }

    if (prune) {
        const snap = await db.collection(COLLECTION).get();
        for (const doc of snap.docs) {
            if (!jsonIds.has(doc.id)) {
                if (dryRun) {
                    console.log(`🧪 (dry-run) would delete stale doc ${COLLECTION}/${doc.id}`);
                } else {
                    await doc.ref.delete();
                    console.log(`🗑️  Pruned stale doc ${COLLECTION}/${doc.id}`);
                    pruned++;
                }
            }
        }
    }

    console.log(`\nDone. written=${written} pruned=${pruned} dryRun=${dryRun} prune=${prune}`);
    process.exit(0);
}

main().catch((err) => {
    console.error("❌ Sync failed:", err);
    process.exit(1);
});
