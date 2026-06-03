import type { IPowerEffect, PatternBox, PowerLevelData, PowerOutcomeModification } from "./types.js";

/**
 * Generic power effect — server stores metadata (maxUsesPerMatch, label, role)
 * AND per-level tunables read from Firestore `powerDefinitions`. Most power
 * *behaviour* is applied client-side by Power_Manager, but four
 * server-authoritative paths (Sledge ball counter, BoundaryLegend countdown,
 * WicketMaster run deduction, Defense width reduction) read their per-level
 * values from this effect via `getLevelData(level)`.
 *
 * Accept any effectType — unknown types still return a valid effect with safe
 * defaults, so newly-added Firestore powers don't require a server redeploy.
 */
class GenericPowerEffect implements IPowerEffect {
    readonly effectTypeKey: string;
    role: "batsman" | "bowler";
    activation: "passive" | "triggered";
    maxUsesPerMatch: number;
    label: string;
    /** Per-power upgrade level (1..4). Used by server-side power math. */
    level: number;
    /** Per-level tunables from `powerSettings.levels[]`. Empty when only
     *  legacy flat settings exist. */
    private levels: PowerLevelData[] = [];
    /** Power-wide settings beyond the per-level array. Defense uses
     *  `minimumWidthMultiplier` here. */
    private powerWide: Record<string, any> = {};

    constructor(effectType: string) {
        this.effectTypeKey   = effectType;
        this.role            = "batsman";
        this.activation      = "passive";
        this.maxUsesPerMatch = 999;
        this.label           = effectType;
        this.level           = 1;
    }

    loadSettings(s: Record<string, any>): void {
        if (!s) return;

        // Tolerate either shape: caller may pass the merged
        // `data.settings + data.powerSettings` map (loader.ts does this) OR
        // the legacy flat `data.settings` map alone. New shape wins where
        // both are present because loader.ts spreads powerSettings last.
        // maxUsesPerMatch may be authored TOP-LEVEL (legacy flat) or PER-LEVEL inside
        // levels[] — the current admin/seed shape, which mirrors the client's per-level
        // read. The cap is flat per power (the seed uses the same value on every level),
        // so when no top-level value is present we adopt the first per-level entry's value.
        // Without this the server ignored the seeded per-level cap and enforced the 999
        // default, so every power read as "unlimited" on the client uses-ring.
        if (typeof s.maxUsesPerMatch === "number") {
            this.maxUsesPerMatch = s.maxUsesPerMatch;
        } else if (Array.isArray(s.levels) && s.levels.length > 0
                   && typeof s.levels[0]?.maxUsesPerMatch === "number") {
            this.maxUsesPerMatch = s.levels[0].maxUsesPerMatch;
        }
        if (typeof s.label           === "string") this.label           = s.label;
        if (s.role === "batsman" || s.role === "bowler")               this.role       = s.role;
        if (s.activation === "passive" || s.activation === "triggered") this.activation = s.activation;
        if (typeof s.level === "number")           this.level           = Math.max(1, Math.min(4, s.level));

        // New per-level array (Cards/Powers/Powers.md §4 shape).
        if (Array.isArray(s.levels)) {
            this.levels = s.levels as PowerLevelData[];
            // Power-wide top-level fields = everything OTHER than `levels` and
            // the metadata keys we already absorbed above.
            for (const k of Object.keys(s)) {
                if (k === "levels" || k === "label" || k === "role"
                    || k === "activation" || k === "level"
                    || k === "maxUsesPerMatch") continue;
                this.powerWide[k] = s[k];
            }
        }
    }

    getLevelData(level: number): PowerLevelData {
        if (!this.levels || this.levels.length === 0) return {};
        const idx = Math.max(1, Math.min(this.levels.length, level)) - 1;
        return this.levels[idx] ?? {};
    }

    getPowerWideValue(key: string): number | string | boolean | undefined {
        const v = this.powerWide[key];
        return (typeof v === "number" || typeof v === "string" || typeof v === "boolean") ? v : undefined;
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
