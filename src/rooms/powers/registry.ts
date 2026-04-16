import type { IPowerEffect } from "./types.js";
import { PressureAuraEffect } from "./PressureAuraEffect.js";
import { ShieldWicketEffect } from "./ShieldWicketEffect.js";
import { DoubleScoreEffect } from "./DoubleScoreEffect.js";
import { ExtraLifeEffect } from "./ExtraLifeEffect.js";
import { SpeedBoostEffect } from "./SpeedBoostEffect.js";
import { TimeFreezeEffect } from "./TimeFreezeEffect.js";
import { GhostBallEffect } from "./GhostBallEffect.js";
import { SteadyHandEffect } from "./SteadyHandEffect.js";
import { ColourCodeEffect } from "./ColourCodeEffect.js";
import { PredictionLineEffect } from "./PredictionLineEffect.js";

const factories: Record<string, () => IPowerEffect> = {
    PressureAura:   () => new PressureAuraEffect(),
    ShieldWicket:   () => new ShieldWicketEffect(),
    DoubleScore:    () => new DoubleScoreEffect(),
    ExtraLife:      () => new ExtraLifeEffect(),
    SpeedBoost:     () => new SpeedBoostEffect(),
    TimeFreeze:     () => new TimeFreezeEffect(),
    GhostBall:      () => new GhostBallEffect(),
    SteadyHand:     () => new SteadyHandEffect(),
    ColourCode:     () => new ColourCodeEffect(),
    PredictionLine: () => new PredictionLineEffect(),
};

/**
 * Creates and initializes a power effect from its effectType key and settings.
 * Returns null for unknown types.
 */
export function createPowerEffect(effectType: string, settings: Record<string, any> = {}): IPowerEffect | null {
    const factory = factories[effectType];
    if (!factory) {
        console.warn(`[PowerRegistry] Unknown effect type: ${effectType}`);
        return null;
    }
    const effect = factory();
    effect.loadSettings(settings);
    return effect;
}

/**
 * Register a new power effect type at runtime.
 */
export function registerPowerEffect(effectType: string, factory: () => IPowerEffect): void {
    factories[effectType] = factory;
}
