/**
 * Pattern box as used in server-side pattern generation.
 */
export interface PatternBox {
    value: number;   // -1=Wicket, 0=Dot, 1=Single, 2=Double, 3=Triple, 4=Four, 6=Six
    width: number;   // Relative width (higher = easier to hit)
}

/**
 * Result of a power modifying a ball outcome.
 */
export interface PowerOutcomeModification {
    newValue?: number;
    newRuns?: number;
    outcomeOverride?: string; // "dot" | "run" | "wicket"
    consumed: boolean;        // true if this power "fired"
}

/**
 * Per-level tunables loaded from Firestore `powerDefinitions/{id}.powerSettings.levels[]`.
 * Shape varies per power — see Cards/Powers/Powers.md §4. Common fields are
 * `level`, `maxUsesPerMatch`, `cooldownSeconds`; per-power fields are
 * `widthMultiplier` (BoundaryMaster), `runDeductionPerWicket` (WicketMaster),
 * `freeHitBalls` (Sledge), `forcedBoundaryBalls` (BoundaryLegend),
 * `widthReductionPerWicket` (Defense), etc.
 */
export type PowerLevelData = Record<string, number | string | boolean>;

/**
 * Power-wide settings beyond the level array. Defense's
 * `minimumWidthMultiplier` lives here.
 */
export interface PowerSettings {
    levels: PowerLevelData[];
    [key: string]: any;
}

/**
 * Strategy interface for power effects.
 * Each power type implements this with its own settings and behavior.
 */
export interface IPowerEffect {
    readonly effectTypeKey: string;
    readonly role: "batsman" | "bowler";
    readonly activation: "passive" | "triggered";
    readonly maxUsesPerMatch: number;
    readonly label: string;
    /** Seeded default upgrade level (1..4). Drives server-side power math when no
     *  per-player level is supplied via select_X messages. */
    readonly level: number;

    /**
     * Loads either the legacy flat `settings` map or the new
     * `powerSettings` object (with `levels[]`). Implementations should
     * tolerate both shapes during the migration window.
     */
    loadSettings(settings: Record<string, any>): void;

    /**
     * Returns the per-level data for the given card level (1..MaxLevel).
     * Falls back to an empty object when no levels[] is configured (legacy
     * docs or powers without per-level tunables). Server-authoritative
     * paths (Sledge, BoundaryLegend, WicketMaster, Defense) read their
     * per-level values from this.
     */
    getLevelData(level: number): PowerLevelData;

    /**
     * Returns the power-wide value at `key` (top-level field on
     * powerSettings, NOT a per-level field). Used for Defense's
     * minimumWidthMultiplier. Returns undefined when not set.
     */
    getPowerWideValue(key: string): number | string | boolean | undefined;

    /** Modify pattern boxes before rendering. Returns modified boxes. */
    applyToPattern(boxes: PatternBox[]): PatternBox[];

    /** Modify arrow speed. Returns new speed. */
    modifyArrowSpeed(currentSpeed: number): number;

    /** Modify ball outcome after tap. */
    modifyOutcome(boxValue: number, runs: number, outcome: string): PowerOutcomeModification;
}
