import type { IPowerEffect, PatternBox, PowerOutcomeModification } from "./types.js";

/**
 * Generic power effect — server stores only metadata (maxUsesPerMatch, label, role)
 * read from Firestore `powerDefinitions`. All power *behaviour* is applied
 * client-side by PowerSystem. The server never mutates patterns, slider speed,
 * or ball outcomes from a power.
 *
 * Accept any effectType — unknown types still return a valid effect with safe
 * defaults, so newly-added Firestore powers don't require a server redeploy.
 */
class GenericPowerEffect implements IPowerEffect {
    readonly effectTypeKey: string;
    readonly role: "batsman" | "bowler";
    readonly activation: "passive" | "triggered";
    maxUsesPerMatch: number;
    label: string;

    constructor(effectType: string) {
        this.effectTypeKey   = effectType;
        this.role            = "batsman";  // overridden by loadSettings if Firestore provides
        this.activation      = "passive";  // overridden by loadSettings if Firestore provides
        this.maxUsesPerMatch = 999;
        this.label           = effectType;
    }

    loadSettings(s: Record<string, any>): void {
        if (typeof s.maxUsesPerMatch === "number") this.maxUsesPerMatch = s.maxUsesPerMatch;
        if (typeof s.label === "string")           this.label           = s.label;
        // role/activation are readonly so they stay at constructor defaults.
    }

    applyToPattern(boxes: PatternBox[]): PatternBox[] {
        return boxes; // Server never modifies pattern; client does.
    }

    modifyArrowSpeed(currentSpeed: number): number {
        return currentSpeed; // Server never modifies slider; client does.
    }

    modifyOutcome(_boxValue: number, _runs: number, _outcome: string): PowerOutcomeModification {
        return { consumed: false }; // Server never mutates outcome; client does.
    }
}

/**
 * Creates a GenericPowerEffect for any effectType. Never returns null — accept
 * any Firestore-defined power id without server-side code changes.
 */
export function createPowerEffect(effectType: string, settings: Record<string, any> = {}): IPowerEffect {
    const effect = new GenericPowerEffect(effectType);
    effect.loadSettings(settings);
    return effect;
}

/**
 * Kept for backward compatibility with loader.ts — noop.
 */
export function registerPowerEffect(_effectType: string, _factory: () => IPowerEffect): void {
    // Generic effect handles everything — no per-type registration needed.
}
