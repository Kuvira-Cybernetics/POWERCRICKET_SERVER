import { BasePowerEffect } from "./BasePowerEffect.js";

export class SteadyHandEffect extends BasePowerEffect {
    readonly effectTypeKey = "SteadyHand";
    readonly role = "batsman" as const;
    readonly activation = "passive" as const;
    readonly maxUsesPerMatch = 999;
    readonly label = "Steady Hand";

    private wobbleReductionFactor = 0.3;

    loadSettings(s: Record<string, any>): void {
        if (s.wobbleReductionFactor != null) this.wobbleReductionFactor = s.wobbleReductionFactor;
    }

    // TODO: implement modifyArrowSpeed when designing this power
}
