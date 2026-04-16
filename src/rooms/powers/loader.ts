import type { IPowerEffect } from "./types.js";
import { createPowerEffect } from "./registry.js";

/**
 * In-memory cache of power effect instances loaded from Firestore.
 * Populated at server startup or MatchRoom.onCreate().
 */
const powerCache = new Map<string, IPowerEffect>();

/**
 * Load power definitions from Firestore and cache as IPowerEffect instances.
 * Call once at server startup. Falls back to hardcoded defaults if Firestore unavailable.
 */
export async function loadPowerDefinitions(db?: FirebaseFirestore.Firestore): Promise<void> {
    if (!db) {
        console.log("[PowerLoader] No Firestore instance — using hardcoded defaults.");
        loadDefaults();
        return;
    }

    try {
        const snapshot = await db.collection("powerDefinitions").get();
        let loaded = 0;
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const effectType = data.effectType as string;
            const settings = data.settings ?? {};
            const effect = createPowerEffect(effectType, settings);
            if (effect) {
                powerCache.set(effectType, effect);
                loaded++;
            }
        }
        console.log(`[PowerLoader] Loaded ${loaded} power definitions from Firestore.`);
    } catch (err) {
        console.warn("[PowerLoader] Firestore load failed, using defaults:", err);
        loadDefaults();
    }
}

/**
 * Get a cached power effect by effectType key.
 * Returns null if not found.
 */
export function getPowerEffect(effectType: string): IPowerEffect | null {
    return powerCache.get(effectType) ?? createPowerEffect(effectType, {});
}

/**
 * Load default power effects (no Firestore settings — uses class defaults).
 */
function loadDefaults(): void {
    const defaultTypes = [
        "PressureAura", "ShieldWicket", "DoubleScore", "ExtraLife",
        "SpeedBoost", "TimeFreeze", "GhostBall", "SteadyHand",
        "ColourCode", "PredictionLine",
    ];
    for (const t of defaultTypes) {
        const effect = createPowerEffect(t, {});
        if (effect) powerCache.set(t, effect);
    }
    console.log(`[PowerLoader] Loaded ${powerCache.size} default power definitions.`);
}
