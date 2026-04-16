import { BasePowerEffect } from "./BasePowerEffect.js";

export class SpeedBoostEffect extends BasePowerEffect {
    readonly effectTypeKey = "SpeedBoost";
    readonly role = "bowler" as const;
    readonly activation = "triggered" as const;
    readonly maxUsesPerMatch = 3;
    readonly label = "Speed Boost";

    private speedMultiplier = 1.5;
    private cooldownSeconds = 3;
    private durationSeconds = 5;

    loadSettings(s: Record<string, any>): void {
        if (s.speedMultiplier != null) this.speedMultiplier = s.speedMultiplier;
        if (s.cooldownSeconds != null) this.cooldownSeconds = s.cooldownSeconds;
        if (s.durationSeconds != null) this.durationSeconds = s.durationSeconds;
    }

    // TODO: implement modifyArrowSpeed when designing this power
}
