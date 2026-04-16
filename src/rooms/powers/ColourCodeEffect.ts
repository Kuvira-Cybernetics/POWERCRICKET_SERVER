import { BasePowerEffect } from "./BasePowerEffect.js";

export class ColourCodeEffect extends BasePowerEffect {
    readonly effectTypeKey = "ColourCode";
    readonly role = "batsman" as const;
    readonly activation = "passive" as const;
    readonly maxUsesPerMatch = 999;
    readonly label = "Colour Code";
    // Visual-only, no server-side behavior needed.
}
