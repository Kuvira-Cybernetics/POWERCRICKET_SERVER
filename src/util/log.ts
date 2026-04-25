/**
 * Structured log shim. Emits a single JSON line per event so downstream log
 * aggregators (Datadog, Loki, etc.) can index fields without regex on prose.
 *
 * Usage:
 *   log("MatchRoom", "phase_change", { from: "toss", to: "player_selection" });
 *
 * Line shape:
 *   {"c":"MatchRoom","e":"phase_change","p":{...},"t":1712345000000}
 *
 * Deliberately short keys: "c" component, "e" event, "p" payload, "t" unix-ms.
 *
 * This shim does NOT replace `MatchRoom.trace()` — the tracer's "####_" prefix
 * is what lets the DevHUD / correlation flow work. Use `log()` for prose that
 * was previously `console.log(...)` and is not required for client correlation.
 */
// Silenced while debugging pattern/power generation. Flip STRUCTURED_LOG=1 (env)
// to restore structured observability output.
const STRUCTURED_LOG_ENABLED = process.env.STRUCTURED_LOG === "1";

export function log(component: string, event: string, payload?: Record<string, unknown>): void {
    if (!STRUCTURED_LOG_ENABLED) return;
    const line = {
        c: component,
        e: event,
        p: payload ?? {},
        t: Date.now(),
    };
    // Write directly to stdout so we bypass the `####_`-only console.log
    // silencer installed in MatchRoom.ts. Structured logs are first-class
    // observability signal and must not be filtered by that shim.
    process.stdout.write(JSON.stringify(line) + "\n");
}

/** Convenience: warning-level structured log written to stderr. */
export function warn(component: string, event: string, payload?: Record<string, unknown>): void {
    if (!STRUCTURED_LOG_ENABLED) return;
    const line = {
        c: component,
        e: event,
        p: payload ?? {},
        t: Date.now(),
        level: "warn",
    };
    process.stderr.write(JSON.stringify(line) + "\n");
}
