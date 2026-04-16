import { BasePowerEffect } from "./BasePowerEffect.js";

export class PredictionLineEffect extends BasePowerEffect {
    readonly effectTypeKey = "PredictionLine";
    readonly role = "batsman" as const;
    readonly activation = "passive" as const;
    readonly maxUsesPerMatch = 999;
    readonly label = "Prediction Line";
    // Visual-only, no server-side behavior needed.
}
