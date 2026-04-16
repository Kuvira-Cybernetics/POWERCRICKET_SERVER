import { BasePowerEffect } from "./BasePowerEffect.js";

export class ExtraLifeEffect extends BasePowerEffect {
    readonly effectTypeKey = "ExtraLife";
    readonly role = "batsman" as const;
    readonly activation = "triggered" as const;
    readonly maxUsesPerMatch = 1;
    readonly label = "Extra Life";

    private cooldownSeconds = 10;

    loadSettings(s: Record<string, any>): void {
        if (s.cooldownSeconds != null) this.cooldownSeconds = s.cooldownSeconds;
    }

    // TODO: implement modifyOutcome when designing this power
}
