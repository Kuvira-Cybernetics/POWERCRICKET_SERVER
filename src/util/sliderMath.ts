// Port of POWERC/Assets/Scripts/Match/SliderAnimationManager.cs +
// POWERC/Assets/Scripts/Core/TweenManager.cs easing math. Keep in sync.
//
// Used to compute the bot batsman's tap position deterministically so the
// server picks the exact slider spot the client will be rendering at tap time.
// Eliminates the visible "jump" on freeze when the opponent is a bot.

export type SliderEase =
    | "Linear"
    | "EaseInOutQuad"
    | "EaseInOutCubic"
    | "EaseOutCubic"
    | "EaseOutBack"
    | "EaseOutBounce"
    | "EaseOutElastic";

// Role multipliers applied on the client side
// (FastBallBattingScreen_Manager.ApplyBattingRole / ApplyBowlingRole).
// Server must apply the same multipliers to its broadcast arrowSpeed before
// feeding into sweepsPerSecond, otherwise the oscillation period diverges.
export function battingRoleMultiplier(role: string | undefined | null): number {
    switch (role) {
        case "BattingStrategy": return 1.00;
        case "BattingDefense":  return 0.85;
        default:                return 1.00;
    }
}

export function bowlingRoleMultiplier(role: string | undefined | null): number {
    switch (role) {
        case "BowlingFast": return 1.15;
        case "BowlingSpin": return 1.08;
        default:            return 1.00;
    }
}

// ── Easing (mirror TweenManager.Evaluate) ─────────────────────────────────

function applyEase(ease: SliderEase, t: number): number {
    switch (ease) {
        case "Linear":         return t;
        case "EaseInOutQuad":  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        case "EaseInOutCubic": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        case "EaseOutCubic":   return 1 - Math.pow(1 - t, 3);
        case "EaseOutBack": {
            const c1 = 1.70158;
            const c3 = c1 + 1;
            return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        }
        case "EaseOutBounce": {
            const n1 = 7.5625;
            const d1 = 2.75;
            if (t < 1 / d1)   return n1 * t * t;
            if (t < 2 / d1) { t -= 1.5  / d1; return n1 * t * t + 0.75; }
            if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
            t -= 2.625 / d1;  return n1 * t * t + 0.984375;
        }
        case "EaseOutElastic": {
            if (t === 0 || t === 1) return t;
            const c4 = (2 * Math.PI) / 3;
            return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
        }
        default: return t;
    }
}

// ── Oscillation (mirror SliderAnimationManager.ComputeNormalizedPosition) ─

/**
 * Returns the slider's normalised position (-0.5 .. +0.5) at a given elapsed
 * time. Pure function — same inputs always return the same output.
 *
 * @param elapsedSec   seconds since StartOscillation
 * @param sweepDurSec  1 / sweepsPerSecond
 * @param ease         easing curve used per sweep (client default: EaseInOutCubic)
 */
export function computeNormalizedPosition(
    elapsedSec: number,
    sweepDurSec: number,
    ease: SliderEase,
): number {
    const sweepIndex = Math.floor(elapsedSec / sweepDurSec);
    const t = clamp01((elapsedSec - sweepIndex * sweepDurSec) / sweepDurSec);
    const eased = applyEase(ease, t);
    const goingRight = (sweepIndex % 2) === 0;
    return goingRight
        ? lerpUnclamped(-0.5, 0.5, eased)
        : lerpUnclamped(0.5, -0.5, eased);
}

/**
 * Convenience wrapper — returns the slider position in 0..1 space (wire format
 * used by ball_result.sliderPosition and handleBatsmanTap msg.position).
 */
export function computeWirePosition(
    elapsedSec: number,
    sweepDurSec: number,
    ease: SliderEase,
): number {
    return clamp01(computeNormalizedPosition(elapsedSec, sweepDurSec, ease) + 0.5);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerpUnclamped(a: number, b: number, t: number): number { return a + (b - a) * t; }
