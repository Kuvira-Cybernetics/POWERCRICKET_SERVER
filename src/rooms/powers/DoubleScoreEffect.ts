import { BasePowerEffect } from "./BasePowerEffect.js";

export class DoubleScoreEffect extends BasePowerEffect {
    readonly effectTypeKey = "DoubleScore";
    readonly role = "batsman" as const;
    readonly activation = "triggered" as const;
    readonly maxUsesPerMatch = 1;
    readonly label = "2x Score";

    private runMultiplier = 2;
    private cooldownSeconds = 5;

    loadSettings(s: Record<string, any>): void {
        if (s.runMultiplier != null) this.runMultiplier = s.runMultiplier;
        if (s.cooldownSeconds != null) this.cooldownSeconds = s.cooldownSeconds;
    }

    // TODO: implement applyToPattern, modifyOutcome when designing this power
}
