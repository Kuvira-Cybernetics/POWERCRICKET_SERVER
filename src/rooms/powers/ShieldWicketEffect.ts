import { BasePowerEffect } from "./BasePowerEffect.js";

export class ShieldWicketEffect extends BasePowerEffect {
    readonly effectTypeKey = "ShieldWicket";
    readonly role = "batsman" as const;
    readonly activation = "triggered" as const;
    readonly maxUsesPerMatch = 2;
    readonly label = "Shield Wicket";

    private cooldownSeconds = 6;

    loadSettings(s: Record<string, any>): void {
        if (s.maxUsesPerMatch != null) (this as any).maxUsesPerMatch = s.maxUsesPerMatch;
        if (s.cooldownSeconds != null) this.cooldownSeconds = s.cooldownSeconds;
    }

    // TODO: implement modifyOutcome when designing this power
}
