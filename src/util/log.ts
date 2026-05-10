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

/**
 * Wraps an outbound message payload with a server-side `t` field (Unix ms).
 *
 * Usage at every `client.send(...)` / `this.broadcast(...)` site:
 *   client.send("ball_result", stamp({ runs, wicket, cid }));
 *
 * Why this exists:
 *   • The client-side PatternDebugHUD TIME panel computes server↔local clock
 *     drift from any inbound `t` field. Without uniform stamping, the panel
 *     samples only on a handful of message types (catch_start) and looks
 *     dead during normal play.
 *   • Future replay tooling can sort by `t` deterministically without
 *     parsing message-specific timestamp fields (`serverStartTime`,
 *     `matchStartedAt`, etc).
 *
 * Bitwise safety (CLAUDE.md rule #1): plain `Date.now()` here is safe — we
 * never run it through bitwise ops. Any caller mixing `Date.now()` with `^`,
 * `|`, `&`, `<<`, `>>` MUST coerce with `>>> 0`.
 *
 * Belt+suspenders: existing message-specific timestamps (e.g. `ball_start`'s
 * `serverStartTime` in seconds) are NOT removed. They stay so historical
 * client code keeps working. The new `t` field is additive.
 */
export function stamp<T extends object>(payload: T): T & { t: number } {
    return { ...payload, t: Date.now() };
}
