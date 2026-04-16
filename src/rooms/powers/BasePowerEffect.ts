import type { IPowerEffect, PatternBox, PowerOutcomeModification } from "./types.js";

/**
 * Abstract base for all power effects.
 * Provides default no-op implementations so concrete classes only override what they need.
 */
export abstract class BasePowerEffect implements IPowerEffect {
    abstract readonly effectTypeKey: string;
    abstract readonly role: "batsman" | "bowler";
    abstract readonly activation: "passive" | "triggered";
    abstract readonly maxUsesPerMatch: number;
    abstract readonly label: string;

    loadSettings(_settings: Record<string, any>): void {
        // Subclasses override to parse their typed settings.
    }

    applyToPattern(boxes: PatternBox[]): PatternBox[] {
        return boxes; // No modification by default.
    }

    modifyArrowSpeed(currentSpeed: number): number {
        return currentSpeed; // No modification by default.
    }

    modifyOutcome(_boxValue: number, _runs: number, _outcome: string): PowerOutcomeModification {
        return { consumed: false }; // No modification by default.
    }
}
