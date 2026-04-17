/**
 * Server-side game config loaded from Firestore `gameConfig` collection.
 *
 * Schema: one document per config key. The admin site writes each document as:
 *   gameConfig/{snake_case_key} → { key, value, label, description, type }
 *
 * Server reads all docs on startup and every 5 minutes, mapping snake_case keys
 * to typed camelCase fields. This keeps server + Unity client + admin site on a
 * single source of truth (all three read/write the same collection).
 *
 * Consumers call getGameConfig() — never cache the returned object long-term;
 * always re-fetch at the moment of use so admin edits propagate.
 */

export interface GameConfig {
    // ── Match format ─────────────────────────────────────────────────────────
    oversPerMatch: number;
    ballsPerOver: number;
    maxWickets: number;
    superOverEnabled: boolean;
    arrowSpeedMultiplier: number;

    // ── Pattern ──────────────────────────────────────────────────────────────
    patternSweepsPerSecond: number;

    // ── Fielding / catch mechanics ───────────────────────────────────────────
    catchBoxWidthPercent: number;
    catchBoxSpeed: number;
    spinBattingRotationSpeed: number;
    spinballCatchRotationSpeed: number;
    spinballCatchArcWidth: number;

    // ── Team rules ───────────────────────────────────────────────────────────
    teamSize: number;
    requiredBattingPlayers: number;
    minBowlingPlayers: number;
    teamMaxSpinBowlers: number;       // admin key: max_spin_players
    teamMinFastBowlers: number;       // NOT admin-editable (server default)
    maxPowersPerPlayer: number;

    // ── Turn timers ──────────────────────────────────────────────────────────
    tossAnimationSeconds: number;
    lineupSelectionSeconds: number;
    preMatchLobbySeconds: number;
    inningsBreakSeconds: number;
    matchTimerPerBall: number;
    matchSearchDisplaySeconds: number;

    // ── Economy ──────────────────────────────────────────────────────────────
    coinRewardWin: number;
    coinRewardLoss: number;
    xpRewardWin: number;
    xpRewardLoss: number;
    trophyRewardWin: number;
    trophyRewardLoss: number;
    dailyDealRotation: number;

    // ── Matchmaking / network ────────────────────────────────────────────────
    matchmakingTimeout: number;      // seconds
    botInjectionRate: number;        // 0..1
    disconnectGracePeriod: number;   // seconds

    // ── Bot difficulty (server-authoritative, never exposed to clients) ──────
    botCatchRate: number;            // 0..1 — chance bot fields a 4/6 successfully
    botWicketZoneFactor: number;     // 0..1 — multiplier on wicket zone weight when bot bowls
}

const DEFAULTS: GameConfig = {
    // Match format
    oversPerMatch:              3,
    ballsPerOver:               6,
    // maxWickets is DYNAMICALLY overridden per innings in MatchRoom.startInnings()
    // as (battingCardCount - 1). Example: 3 batting cards → 2 wickets end innings.
    // This default (1) is just a safety floor used before the first innings starts;
    // it is replaced by the real value the moment startInnings(1) runs.
    maxWickets:                 1,
    superOverEnabled:           true,
    arrowSpeedMultiplier:       1.0,

    // Pattern
    patternSweepsPerSecond:     2.0,

    // Fielding
    catchBoxWidthPercent:       15.0,
    catchBoxSpeed:              1.0,
    spinBattingRotationSpeed:   180.0,
    spinballCatchRotationSpeed: 180.0,
    spinballCatchArcWidth:      12.0,

    // Team
    teamSize:                   5,
    requiredBattingPlayers:     2,
    minBowlingPlayers:          2,
    teamMaxSpinBowlers:         2,
    teamMinFastBowlers:         1,
    maxPowersPerPlayer:         3,

    // Timers
    tossAnimationSeconds:       3.0,
    lineupSelectionSeconds:     30,
    preMatchLobbySeconds:       10,
    inningsBreakSeconds:        10,
    matchTimerPerBall:          30,
    matchSearchDisplaySeconds:  3,

    // Economy
    coinRewardWin:              50,
    coinRewardLoss:             15,
    xpRewardWin:                30,
    xpRewardLoss:               10,
    trophyRewardWin:            30,
    trophyRewardLoss:           -20,
    dailyDealRotation:          24,

    // Matchmaking
    matchmakingTimeout:         30,
    botInjectionRate:           0.3,
    disconnectGracePeriod:      30,

    // Bot difficulty
    botCatchRate:               0.1,
    botWicketZoneFactor:        0.1,
};

/**
 * Mapping: admin's snake_case Firestore key → server's camelCase field name.
 * Every key Admin can edit appears here. Keys without a mapping are ignored.
 * Two admin keys map to the same server field where there's a historical alias.
 */
const KEY_MAP: Record<string, keyof GameConfig> = {
    // Match format
    match_overs:                     "oversPerMatch",
    balls_per_over:                  "ballsPerOver",
    max_wickets:                     "maxWickets",
    super_over_enabled:              "superOverEnabled",
    arrow_speed:                     "arrowSpeedMultiplier",

    // Pattern
    pattern_sweeps_per_second:       "patternSweepsPerSecond",

    // Fielding
    catch_box_width_percent:         "catchBoxWidthPercent",
    catch_box_speed:                 "catchBoxSpeed",
    spin_batting_rotation_speed:     "spinBattingRotationSpeed",
    spinball_catch_rotation_speed:   "spinballCatchRotationSpeed",
    spinball_catch_arc_width:        "spinballCatchArcWidth",

    // Team
    team_size:                       "teamSize",
    required_batting_players:        "requiredBattingPlayers",
    min_bowling_players:             "minBowlingPlayers",
    max_spin_players:                "teamMaxSpinBowlers",
    max_powers_per_player:           "maxPowersPerPlayer",

    // Timers
    toss_animation_seconds:          "tossAnimationSeconds",
    lineup_selection_seconds:        "lineupSelectionSeconds",
    pre_match_lobby_seconds:         "preMatchLobbySeconds",
    innings_break_seconds:           "inningsBreakSeconds",
    match_timer_per_ball:            "matchTimerPerBall",
    match_search_display_seconds:    "matchSearchDisplaySeconds",

    // Economy
    win_coins:                       "coinRewardWin",
    loss_coins:                      "coinRewardLoss",
    win_xp:                          "xpRewardWin",
    loss_xp:                         "xpRewardLoss",
    win_trophies:                    "trophyRewardWin",
    loss_trophies:                   "trophyRewardLoss",
    daily_deal_rotation:             "dailyDealRotation",

    // Matchmaking
    matchmaking_timeout:             "matchmakingTimeout",
    bot_injection_rate:              "botInjectionRate",
    reconnect_grace_period:          "disconnectGracePeriod",

    // Bot difficulty (server-private keys — admin may or may not expose them;
    // kept in the map so any doc with these ids is honored.)
    bot_catch_rate:                  "botCatchRate",
    bot_wicket_zone_factor:          "botWicketZoneFactor",
};

/** Sanity bounds so a bad admin value can't take the server into a broken state. */
const BOUNDS: Partial<Record<keyof GameConfig, [number, number]>> = {
    oversPerMatch:              [1, 20],
    ballsPerOver:               [1, 12],
    maxWickets:                 [1, 11],
    arrowSpeedMultiplier:       [0.1, 10],
    patternSweepsPerSecond:     [0.1, 20],
    catchBoxWidthPercent:       [1, 100],
    catchBoxSpeed:              [0.1, 20],
    spinBattingRotationSpeed:   [1, 1440],
    spinballCatchRotationSpeed: [1, 1440],
    spinballCatchArcWidth:      [1, 100],
    teamSize:                   [1, 11],
    requiredBattingPlayers:     [1, 11],
    minBowlingPlayers:          [1, 11],
    teamMaxSpinBowlers:         [0, 11],
    teamMinFastBowlers:         [0, 11],
    maxPowersPerPlayer:         [0, 10],
    tossAnimationSeconds:       [0, 60],
    lineupSelectionSeconds:     [0, 300],
    preMatchLobbySeconds:       [0, 300],
    inningsBreakSeconds:        [0, 300],
    matchTimerPerBall:          [1, 300],
    matchSearchDisplaySeconds:  [0, 60],
    coinRewardWin:              [0, 100000],
    coinRewardLoss:             [0, 100000],
    xpRewardWin:                [0, 100000],
    xpRewardLoss:               [0, 100000],
    trophyRewardWin:            [-10000, 10000],
    trophyRewardLoss:           [-10000, 10000],
    dailyDealRotation:          [1, 168],
    matchmakingTimeout:         [5, 300],
    botInjectionRate:           [0, 1],
    disconnectGracePeriod:      [0, 600],
    botCatchRate:               [0, 1],
    botWicketZoneFactor:        [0, 1],
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const COLLECTION          = "gameConfig";

let _cache: GameConfig = { ...DEFAULTS };
let _db: FirebaseFirestore.Firestore | undefined;
let _refreshTimer: NodeJS.Timeout | undefined;

/**
 * Initialize game config. Fetches from Firestore once, then refreshes every 5 minutes.
 * If `db` is undefined, the cache stays on defaults forever.
 */
export async function initGameConfig(db?: FirebaseFirestore.Firestore): Promise<void> {
    _db = db;
    if (!db) {
        console.log("[GameConfig] No Firestore — using built-in defaults.");
        return;
    }

    await refreshGameConfig();

    // Periodic refresh so admin-site changes propagate without server restart.
    if (!_refreshTimer) {
        _refreshTimer = setInterval(() => {
            refreshGameConfig().catch((err) =>
                console.warn("[GameConfig] Refresh failed (keeping previous cache):", err),
            );
        }, REFRESH_INTERVAL_MS);
        // Don't block process exit.
        _refreshTimer.unref?.();
    }
}

/**
 * Force an immediate refresh from Firestore. Safe to call at any time.
 * Preserves the previous cache if the fetch fails.
 */
export async function refreshGameConfig(): Promise<void> {
    if (!_db) return;

    try {
        const snap = await _db.collection(COLLECTION).get();
        if (snap.empty) {
            console.warn(`[GameConfig] ${COLLECTION} collection empty — keeping defaults.`);
            return;
        }

        // Admin writes docs as { key, value, label, description, type }.
        // Build a flat { snake_case_key: value } first, then project into typed fields.
        const raw: Record<string, any> = {};
        let applied = 0;
        snap.forEach((doc) => {
            const data = doc.data() || {};
            const key = typeof data.key === "string" ? data.key : doc.id;
            if (key && "value" in data) {
                raw[key] = data.value;
                applied++;
            }
        });

        _cache = project(raw);
        console.log(`[GameConfig] Loaded ${applied} keys from Firestore ` +
            `(overs=${_cache.oversPerMatch}, balls=${_cache.ballsPerOver}, ` +
            `maxWkts=${_cache.maxWickets}, batting=${_cache.requiredBattingPlayers}, ` +
            `teamSize=${_cache.teamSize})`);
    } catch (err) {
        console.warn("[GameConfig] Fetch failed (keeping previous cache):", err);
    }
}

/**
 * Return the current cached config. Always returns a valid object.
 * Callers should call this at the moment of use — NEVER cache the returned object.
 */
export function getGameConfig(): GameConfig {
    return _cache;
}

/** Project admin's flat {snake_case_key: value} map onto typed camelCase GameConfig. */
function project(raw: Record<string, any>): GameConfig {
    const out: GameConfig = { ...DEFAULTS };

    for (const [snakeKey, fieldName] of Object.entries(KEY_MAP)) {
        if (!(snakeKey in raw)) continue;
        const v = raw[snakeKey];
        const def: any = DEFAULTS[fieldName];

        if (typeof def === "boolean") {
            (out as any)[fieldName] = typeof v === "boolean" ? v : def;
            continue;
        }

        // number field
        let n = typeof v === "number" ? v : Number(v);
        if (!isFinite(n)) { (out as any)[fieldName] = def; continue; }

        const bounds = BOUNDS[fieldName];
        if (bounds) n = Math.max(bounds[0], Math.min(bounds[1], n));
        (out as any)[fieldName] = n;
    }

    return out;
}
