import type { IPowerEffect } from "./types.js";
import { createPowerEffect } from "./registry.js";

/**
 * In-memory cache of power effect instances. Keys are effectType strings.
 * Populated from Firestore `powerDefinitions` at server startup. Missing types
 * are lazy-created on demand by getPowerEffect.
 *
 * All power *behaviour* lives client-side — this cache only stores metadata
 * (maxUsesPerMatch, label) the server uses for activation validation and
 * `power_applied` broadcasts.
 */
const powerCache = new Map<string, IPowerEffect>();

/**
 * Load power definitions from Firestore `powerDefinitions`.
 * Each doc: { effectType: string, settings: { maxUsesPerMatch?, label?, ... } }.
 */
export async function loadPowerDefinitions(db?: FirebaseFirestore.Firestore): Promise<void> {
    if (!db) {
        console.log("[PowerLoader] No Firestore — generic effect created on demand per power.");
        return;
    }

    try {
        const snapshot = await db.collection("powerDefinitions").get();
        let loaded = 0;
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const effectType = data.effectType as string;
            if (!effectType) continue;
            const settings = data.settings ?? {};
            powerCache.set(effectType, createPowerEffect(effectType, settings));
            loaded++;
        }
        console.log(`[PowerLoader] Loaded ${loaded} power definitions from Firestore.`);
    } catch (err) {
        console.warn("[PowerLoader] Firestore load failed — generic effect created on demand per power.", err);
    }
}

/**
 * Return the cached effect for `effectType`, lazily creating one if needed.
 * Never returns null: server accepts any Firestore-defined power id.
 */
export function getPowerEffect(effectType: string): IPowerEffect {
    let effect = powerCache.get(effectType);
    if (!effect) {
        effect = createPowerEffect(effectType, {});
        powerCache.set(effectType, effect);
    }
    return effect;
}
