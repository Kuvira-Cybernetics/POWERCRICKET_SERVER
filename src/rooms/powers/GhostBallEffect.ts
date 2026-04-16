import { BasePowerEffect } from "./BasePowerEffect.js";

export class GhostBallEffect extends BasePowerEffect {
    readonly effectTypeKey = "GhostBall";
    readonly role = "bowler" as const;
    readonly activation = "triggered" as const;
    readonly maxUsesPerMatch = 2;
    readonly label = "Ghost Ball";

    private hideDurationSeconds = 0.5;
    private cooldownSeconds = 3;

    loadSettings(s: Record<string, any>): void {
        if (s.hideDurationSeconds != null) this.hideDurationSeconds = s.hideDurationSeconds;
        if (s.cooldownSeconds != null) this.cooldownSeconds = s.cooldownSeconds;
    }

    // TODO: implement when designing this power (client visual only)
}
