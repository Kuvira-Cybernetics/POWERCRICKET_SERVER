/**
 * Server-side game config loaded from Firestore document `gameConfig/match`.
 *
 * Admin site writes to this doc; server reads on startup and refreshes every 5 minutes.
 * Falls back to sensible defaults if Firestore is unavailable or the doc is missing.
 *
 * Consumers read via getGameConfig() — never cache the returned object long-term;
 * always re-fetch via getGameConfig() at the moment of use so refreshes take effect.
 */

export interface GameConfig {
    // Match format
    oversPerMatch: number;
    ballsPerOver: number;
    superOverEnabled: boolean;

    // Matchmaking
    matchmakingTimeout: number;      // seconds
    botInjectionRate: number;        // 0..1

    // Bot difficulty (server-authoritative; never exposed to clients)
    botCatchRate: number;            // 0..1 — chance bot fields a 4/6 successfully
    botWicketZoneFactor: number;     // 0..1 — multiplier on wicket zone weight when bot bowls

    // Rewards
    coinRewardWin: number;
    coinRewardLoss: number;
    xpRewardWin: number;
    xpRewardLoss: number;
    trophyRewardWin: number;
    trophyRewardLoss: number;

    // Team rules
    teamMaxSpinBowlers: number;
    teamMinFastBowlers: number;
    maxPowersPerPlayer: number;

    // Misc
    disconnectGracePeriod: number;   // seconds
    matchTimerPerBall: number;       // seconds
    arrowSpeedMultiplier: number;
}

const DEFAULTS: GameConfig = {
    oversPerMatch: 3,
    ballsPerOver: 6,
    superOverEnabled: true,
    matchmakingTimeout: 30,
    botInjectionRate: 0.3,
    botCatchRate: 0.1,
    botWicketZoneFactor: 0.1,
    coinRewardWin: 50,
    coinRewardLoss: 15,
    xpRewardWin: 30,
    xpRewardLoss: 10,
    trophyRewardWin: 30,
    trophyRewardLoss: -20,
    teamMaxSpinBowlers: 2,
    teamMinFastBowlers: 1,
    maxPowersPerPlayer: 3,
    disconnectGracePeriod: 30,
    matchTimerPerBall: 30,
    arrowSpeedMultiplier: 1.0,
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const COLLECTION = "gameConfig";
const DOC_ID     = "match";

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
        const doc = await _db.collection(COLLECTION).doc(DOC_ID).get();
        if (!doc.exists) {
            console.warn(`[GameConfig] ${COLLECTION}/${DOC_ID} not found — keeping defaults.`);
            return;
        }

        const data = doc.data() || {};
        _cache = mergeWithDefaults(data);
        console.log(`[GameConfig] Loaded from Firestore (overs=${_cache.oversPerMatch}, ` +
            `balls=${_cache.ballsPerOver}, botCatch=${_cache.botCatchRate}, ` +
            `botWicketFactor=${_cache.botWicketZoneFactor})`);
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

/** Merge partial Firestore data into a fully-typed GameConfig with defaults filling gaps. */
function mergeWithDefaults(data: Record<string, any>): GameConfig {
    const pickNum = (key: keyof GameConfig, min: number, max: number): number => {
        const v = data[key as string];
        if (typeof v !== "number" || !isFinite(v)) return DEFAULTS[key] as number;
        return Math.max(min, Math.min(max, v));
    };
    const pickBool = (key: keyof GameConfig): boolean => {
        const v = data[key as string];
        return typeof v === "boolean" ? v : (DEFAULTS[key] as boolean);
    };

    return {
        oversPerMatch:          pickNum("oversPerMatch", 1, 20),
        ballsPerOver:           pickNum("ballsPerOver", 1, 12),
        superOverEnabled:       pickBool("superOverEnabled"),
        matchmakingTimeout:     pickNum("matchmakingTimeout", 5, 300),
        botInjectionRate:       pickNum("botInjectionRate", 0, 1),
        botCatchRate:           pickNum("botCatchRate", 0, 1),
        botWicketZoneFactor:    pickNum("botWicketZoneFactor", 0, 1),
        coinRewardWin:          pickNum("coinRewardWin", 0, 100000),
        coinRewardLoss:         pickNum("coinRewardLoss", 0, 100000),
        xpRewardWin:            pickNum("xpRewardWin", 0, 100000),
        xpRewardLoss:           pickNum("xpRewardLoss", 0, 100000),
        trophyRewardWin:        pickNum("trophyRewardWin", -10000, 10000),
        trophyRewardLoss:       pickNum("trophyRewardLoss", -10000, 10000),
        teamMaxSpinBowlers:     pickNum("teamMaxSpinBowlers", 0, 11),
        teamMinFastBowlers:     pickNum("teamMinFastBowlers", 0, 11),
        maxPowersPerPlayer:     pickNum("maxPowersPerPlayer", 0, 10),
        disconnectGracePeriod:  pickNum("disconnectGracePeriod", 0, 600),
        matchTimerPerBall:      pickNum("matchTimerPerBall", 1, 300),
        arrowSpeedMultiplier:   pickNum("arrowSpeedMultiplier", 0.1, 10),
    };
}
