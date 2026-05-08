/**
 * Seed `playerCardDefinitions` in Firestore for every playerId referenced by
 * `bot_profiles.json` that doesn't already exist in the catalog.
 *
 * Why: bot profiles reference real player card IDs (e.g. `bat_rare_05`,
 * `bowl_rare_01`). When those docs are missing, `BotTeamBuilder.getCatalogPlayer`
 * returns null, the bot's roster ends up short, and `startInnings` either pads
 * with `reserve_batN` placeholders (legacy) or refuses to pad (post-A8 fix) —
 * both surface as P0-2 / P0-3 in TEST 5/6. This script closes the data gap
 * with stub docs the admin can later enrich (image, full powers, etc.).
 *
 * Behavior:
 *   - For each unique playerId referenced by `src/rooms/bots/bot_profiles.json`:
 *     - If a Firestore doc exists for that playerId, skip.
 *     - Otherwise, write a minimal-but-valid stub:
 *         playerName: derived from id (e.g. "Bat Rare 05")
 *         role:       inferred from id prefix (bat_* → BattingStrategy, bowl_*_fast → BowlingFast, ...)
 *         rarity:     inferred from id (common/rare/epic/legendary)
 *         powerIds:   []  (no powers — admin assigns later)
 *         isEnabled:  true
 *
 * Stubs intentionally omit `powerImageBase64` / `powerImage` so the
 * `####_FALLBACK_PIMG_PLACEHOLDER` warning fires for them — admin sees what to
 * upload next.
 *
 * Usage:
 *   tsx --env-file=.env scripts/seed-missing-player-cards.ts
 *
 * Flags:
 *   --dry-run    Report only; don't write any docs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

const COLLECTION = "playerCardDefinitions";

type BotProfile = {
    botProfileId: string;
    battingPlayers: string[];
    bowlingPlayers: string[];
};

function loadBotProfiles(): BotProfile[] {
    const here = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(here, "..", "src", "rooms", "bots", "bot_profiles.json");
    const raw = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { profiles: BotProfile[] };
    return parsed.profiles || [];
}

function inferRarity(id: string): "Common" | "Rare" | "Epic" | "Legendary" {
    if (id.includes("_legendary_")) return "Legendary";
    if (id.includes("_epic_"))      return "Epic";
    if (id.includes("_rare_"))      return "Rare";
    return "Common";
}

function inferRole(id: string): "BattingStrategy" | "BattingDefense" | "BowlingFast" | "BowlingSpin" {
    // Convention from bot_profiles.json: id prefix is "bat_" or "bowl_".
    // We don't have a sub-class hint, so default batting → Strategy and bowling → Fast.
    // Admin can change role via the editor later.
    if (id.startsWith("bowl_")) return "BowlingFast";
    return "BattingStrategy";
}

function prettyName(id: string): string {
    // bat_rare_05 → "Bat Rare 05"
    return id
        .split("_")
        .map(p => p.length === 0 ? p : p[0].toUpperCase() + p.slice(1))
        .join(" ");
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");

    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT (or use .env.development).");
        process.exit(1);
    }

    // Collect every playerId referenced by every bot profile.
    const profiles = loadBotProfiles();
    const referenced = new Set<string>();
    for (const p of profiles) {
        for (const id of p.battingPlayers || []) referenced.add(id);
        for (const id of p.bowlingPlayers || []) referenced.add(id);
    }
    console.log(`[seed-missing] bot_profiles.json references ${referenced.size} unique playerIds.`);

    // Snapshot existing playerCardDefinitions so we can detect gaps in one query.
    const snap = await db.collection(COLLECTION).get();
    const existing = new Set<string>();
    snap.forEach(doc => {
        const d: any = doc.data() || {};
        const id = (typeof d.playerId === "string" && d.playerId) || doc.id;
        existing.add(id);
    });
    console.log(`[seed-missing] Firestore ${COLLECTION} has ${existing.size} docs.`);

    const missing = Array.from(referenced).filter(id => !existing.has(id));
    if (missing.length === 0) {
        console.log("✅ No missing player card definitions. Nothing to seed.");
        process.exit(0);
    }

    console.log(`[seed-missing] Missing ${missing.length} ids:\n  ${missing.join("\n  ")}`);

    if (dryRun) {
        console.log("--dry-run set; not writing.");
        process.exit(0);
    }

    let created = 0;
    for (const id of missing) {
        const stub = {
            playerId:         id,
            playerName:       prettyName(id),
            role:             inferRole(id),
            rarity:           inferRarity(id),
            powerIds:         [] as string[],
            isEnabled:        true,
            // No image data on purpose — admin enriches via the editor.
            // The runtime will warn `####_FALLBACK_PIMG_PLACEHOLDER` for these,
            // pointing the admin at what to upload next.
        };
        await db.collection(COLLECTION).doc(id).set(stub, { merge: false });
        console.log(`  ✅ created ${id}  role=${stub.role}  rarity=${stub.rarity}`);
        created++;
    }

    console.log(`[seed-missing] Done. created=${created}`);
    process.exit(0);
}

main().catch(err => {
    console.error("[seed-missing] Failed:", err);
    process.exit(1);
});
