import { BasePowerEffect } from "./BasePowerEffect.js";

export class PressureAuraEffect extends BasePowerEffect {
    readonly effectTypeKey = "PressureAura";
    readonly role = "bowler" as const;
    readonly activation = "passive" as const;
    readonly maxUsesPerMatch = 999;
    readonly label = "Pressure Aura";

    // Settings — populated by loadSettings()
    private fourScaleFactor = 0.8;
    private sixScaleFactor = 0.7;
    private arrowSpeedMultiplier = 1.25;

    loadSettings(s: Record<string, any>): void {
        if (s.fourScaleFactor != null) this.fourScaleFactor = s.fourScaleFactor;
        if (s.sixScaleFactor != null) this.sixScaleFactor = s.sixScaleFactor;
        if (s.arrowSpeedMultiplier != null) this.arrowSpeedMultiplier = s.arrowSpeedMultiplier;
    }

    // TODO: implement applyToPattern, modifyArrowSpeed when designing this power
}
