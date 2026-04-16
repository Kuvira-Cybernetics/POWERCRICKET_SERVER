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
 * Strategy interface for power effects.
 * Each power type implements this with its own settings and behavior.
 */
export interface IPowerEffect {
    readonly effectTypeKey: string;
    readonly role: "batsman" | "bowler";
    readonly activation: "passive" | "triggered";
    readonly maxUsesPerMatch: number;
    readonly label: string;

    loadSettings(settings: Record<string, any>): void;

    /** Modify pattern boxes before rendering. Returns modified boxes. */
    applyToPattern(boxes: PatternBox[]): PatternBox[];

    /** Modify arrow speed. Returns new speed. */
    modifyArrowSpeed(currentSpeed: number): number;

    /** Modify ball outcome after tap. */
    modifyOutcome(boxValue: number, runs: number, outcome: string): PowerOutcomeModification;
}
