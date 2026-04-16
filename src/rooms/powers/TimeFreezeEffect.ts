import { BasePowerEffect } from "./BasePowerEffect.js";

export class TimeFreezeEffect extends BasePowerEffect {
    readonly effectTypeKey = "TimeFreeze";
    readonly role = "batsman" as const;
    readonly activation = "triggered" as const;
    readonly maxUsesPerMatch = 2;
    readonly label = "Time Freeze";

    private freezeDurationSeconds = 1;
    private cooldownSeconds = 4;

    loadSettings(s: Record<string, any>): void {
        if (s.freezeDurationSeconds != null) this.freezeDurationSeconds = s.freezeDurationSeconds;
        if (s.cooldownSeconds != null) this.cooldownSeconds = s.cooldownSeconds;
    }

    // TODO: implement when designing this power (client visual + server timeout extension)
}
