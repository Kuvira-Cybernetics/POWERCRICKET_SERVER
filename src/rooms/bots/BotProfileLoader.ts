/**
 * Bot profile loader.
 *
 * Source of truth for bot identity + roster: a curated set of named profiles
 * (one identity, one fixed team) the player faces deterministically.
 *
 * Loading priority:
 *   1. Firestore `botProfiles` collection (live editable via the Unity admin tool).
 *   2. Bundled `bot_profiles.json` (offline / Firestore-down fallback, ships with server).
 *
 * No randomized fallback. If both sources fail, profile lookup returns null and
 * the caller (MatchRoom.injectBot) aborts the bot match. This is intentional —
 * the prior synthetic FALLBACK_BOT_TEAM ID set ("bot_bat1", …) doesn't resolve
 * in the Firestore-backed PlayerImageCache and renders empty bot cards.
 *
 * Selection (pickProfileForPlayer):
 *   * Filter profiles whose [minElo, maxElo] contains the matched player's ELO.
 *   * Prefer profiles the player hasn't faced yet (`alreadyFaced` arg).
 *   * When all profiles in the band have been faced → reset (use full band again).
 *   * Random pick from the remaining candidates.
 *
 * Caller is responsible for:
 *   - reading the player's `botsFaced` array from Firestore (passed in).
 *   - persisting the chosen `botProfileId` back to that array on match_end.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb } from "../../config/firebaseAdmin.js";

export interface BotProfile {
    botProfileId:      string;
    displayName:       string;
    country:           string;
    avatarSpriteIndex: number;
    eloBand:           string;   // Bronze | Silver | Gold | Platinum | Diamond | Master
    minElo:            number;
    maxElo:            number;
    playstyle:         string;   // Aggressive | Defensive | AllRounder | PowerHitter | SpinSpecialist
    bio:               string;
    fakeWinRecord:     string;
    battingPlayers:    string[]; // playerCardDefinitions IDs (3+)
    bowlingPlayers:    string[]; // playerCardDefinitions IDs (2-3, ≥1 Fast, ≤2 Spin)
    isEnabled:         boolean;
}

const COLLECTION                  = "botProfiles";
const VERSION_DOC_PATH             = { col: "gameVersions", doc: "catalog", field: "botProfilesVersion" } as const;
/** Cheap version-check cadence — reads one tiny doc. */
const VERSION_CHECK_INTERVAL_MS    = 30 * 1000;
/** Safety-net full refresh used when the version doc is unreachable. */
const FALLBACK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let _profiles:         BotProfile[] = [];
let _refreshTimer:     NodeJS.Timeout | undefined;
let _initStarted       = false;
/** Last `botProfilesVersion` we've already pulled from Firestore. `null` means
 *  "never read the version doc yet" — the next tick will refresh unconditionally. */
let _lastSeenVersion:  number | null = null;
let _lastFullRefreshAt = 0;

/**
 * Prime the profile cache and start the periodic refresh. Safe to call once at
 * app start; subsequent calls are no-ops.
 *
 * Refresh strategy: every 30s we read just `gameVersions/catalog.botProfilesVersion`
 * (one tiny doc) and only do a full `botProfiles` collection pull when the
 * counter has changed. The admin frontend bumps that counter on every write,
 * so live edits propagate to the server within ~30s instead of the previous
 * blind 5-minute window.
 */
export async function initBotProfileLoader(): Promise<void> {
    if (_initStarted) return;
    _initStarted = true;

    await refreshFromFirestore();
    _lastFullRefreshAt = Date.now();
    _lastSeenVersion = await getServerVersion();

    // Fallback: if Firestore returned nothing (no DB / empty collection / fetch
    // failed), load the bundled JSON so the server can still serve bot matches.
    if (_profiles.length === 0) {
        loadFromJson();
    }

    if (!_refreshTimer) {
        _refreshTimer = setInterval(() => {
            checkAndRefreshIfStale().catch(err =>
                console.warn("[BotProfileLoader] Version-aware refresh failed (keeping previous profiles):", err));
        }, VERSION_CHECK_INTERVAL_MS);
        _refreshTimer.unref?.();
    }
}

/** One tick: read the cheap version counter, full-refresh only on mismatch. */
async function checkAndRefreshIfStale(): Promise<void> {
    const serverVersion = await getServerVersion();

    if (serverVersion === null) {
        // Version doc unreachable — fall back to the legacy 5-min full refresh
        // so we still pick up Firestore edits when gameVersions is missing.
        if (Date.now() - _lastFullRefreshAt >= FALLBACK_REFRESH_INTERVAL_MS) {
            await refreshFromFirestore();
            _lastFullRefreshAt = Date.now();
        }
        return;
    }

    if (_lastSeenVersion === serverVersion) return;

    await refreshFromFirestore();
    _lastFullRefreshAt = Date.now();
    _lastSeenVersion = serverVersion;
    console.log(`[BotProfileLoader] Detected version bump → ${serverVersion}; reloaded ${_profiles.length} profiles.`);
}

async function getServerVersion(): Promise<number | null> {
    const db = getDb();
    if (!db) return null;
    try {
        const snap = await db.collection(VERSION_DOC_PATH.col).doc(VERSION_DOC_PATH.doc).get();
        if (!snap.exists) return null;
        const data = snap.data();
        const v = data?.[VERSION_DOC_PATH.field];
        return typeof v === "number" ? v : null;
    } catch {
        return null;
    }
}

async function refreshFromFirestore(): Promise<void> {
    const db = getDb();
    if (!db) {
        console.warn("[BotProfileLoader] No Firestore client — will use bundled JSON.");
        return;
    }

    try {
        const snap = await db.collection(COLLECTION).get();
        if (snap.empty) {
            console.warn(`[BotProfileLoader] ${COLLECTION} empty — will use bundled JSON.`);
            return;
        }
        const fresh: BotProfile[] = [];
        snap.forEach(doc => {
            const d: any = doc.data() || {};
            const profile: BotProfile = {
                botProfileId:      typeof d.botProfileId      === "string" ? d.botProfileId      : doc.id,
                displayName:       typeof d.displayName       === "string" ? d.displayName       : "",
                country:           typeof d.country           === "string" ? d.country           : "",
                avatarSpriteIndex: typeof d.avatarSpriteIndex === "number" ? d.avatarSpriteIndex : 0,
                eloBand:           typeof d.eloBand           === "string" ? d.eloBand           : "",
                minElo:            typeof d.minElo            === "number" ? d.minElo            : 0,
                maxElo:            typeof d.maxElo            === "number" ? d.maxElo            : 9999,
                playstyle:         typeof d.playstyle         === "string" ? d.playstyle         : "",
                bio:               typeof d.bio               === "string" ? d.bio               : "",
                fakeWinRecord:     typeof d.fakeWinRecord     === "string" ? d.fakeWinRecord     : "",
                battingPlayers:    Array.isArray(d.battingPlayers) ? d.battingPlayers.filter((s: any) => typeof s === "string") : [],
                bowlingPlayers:    Array.isArray(d.bowlingPlayers) ? d.bowlingPlayers.filter((s: any) => typeof s === "string") : [],
                isEnabled:         d.isEnabled !== false,
            };
            if (!profile.botProfileId || !profile.isEnabled) return;
            fresh.push(profile);
        });
        if (fresh.length === 0) {
            console.warn(`[BotProfileLoader] ${COLLECTION} returned no enabled profiles — keeping previous (or falling back to JSON if none).`);
            return;
        }
        _profiles = fresh;
        const buckets = countByBand(_profiles);
        console.log(`[BotProfileLoader] Loaded ${_profiles.length} profiles from Firestore ` +
            `(Bronze=${buckets.Bronze} Silver=${buckets.Silver} Gold=${buckets.Gold} ` +
            `Platinum=${buckets.Platinum} Diamond=${buckets.Diamond} Master=${buckets.Master})`);
    } catch (err) {
        console.warn("[BotProfileLoader] Firestore fetch failed (keeping previous cache):", err);
    }
}

function loadFromJson(): void {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const jsonPath = join(here, "bot_profiles.json");
        const raw = readFileSync(jsonPath, "utf-8");
        const parsed = JSON.parse(raw) as { version: number; profiles: BotProfile[] };
        if (!parsed?.profiles?.length) {
            console.error("[BotProfileLoader] bundled JSON parsed but profiles[] empty — bot matches will fail.");
            _profiles = [];
            return;
        }
        _profiles = parsed.profiles.filter(p => p.isEnabled);
        const buckets = countByBand(_profiles);
        console.error(`####_FALLBACK_BOT_PROFILES_JSON Loaded ${_profiles.length} profiles from bundled JSON ` +
            `(Bronze=${buckets.Bronze} Silver=${buckets.Silver} Gold=${buckets.Gold} ` +
            `Platinum=${buckets.Platinum} Diamond=${buckets.Diamond} Master=${buckets.Master}) — ` +
            `Firestore botProfiles unavailable; live profile edits won't apply.`);
    } catch (err) {
        console.error("[BotProfileLoader] FATAL: failed to load bundled JSON — bot matches will fail:", err);
        _profiles = [];
    }
}

export function getProfileById(id: string): BotProfile | null {
    if (!id) {
        console.warn(`####_BOT_SRV_PROFILE_LOOKUP id=null/empty — caller passed empty/null id; null returned.`);
        return null;
    }
    const found = _profiles.find(p => p.botProfileId === id) ?? null;
    if (found == null) {
        console.warn(`####_BOT_SRV_PROFILE_LOOKUP_MISS id='${id}' — not in _profiles (size=${_profiles.length}). Caller will see null and may fall back to FALLBACK_BOT_TEAM. Verify Firestore botProfiles or bot_profiles.json has this id.`);
    } else {
        console.log(`####_BOT_SRV_PROFILE_LOOKUP_HIT id='${id}' name='${found.displayName}' band='${found.eloBand}' batPlayers=${found.battingPlayers.length} bowlPlayers=${found.bowlingPlayers.length}`);
    }
    return found;
}

export function getProfilesInBand(elo: number): BotProfile[] {
    return _profiles.filter(p => elo >= p.minElo && elo <= p.maxElo);
}

/**
 * Picks a profile for the given player ELO honoring faced-set rotation.
 *
 * `alreadyFaced` is the player's full `botsFaced` array — the function filters
 * it down to the band's profiles internally, so callers don't need to pre-trim.
 *
 * Returns null when no profile in tree for the given ELO band (configuration
 * error — caller should log + abort).
 */
export function pickProfileForPlayer(playerId: string, elo: number, alreadyFaced: string[]): BotProfile | null {
    const inBand = getProfilesInBand(elo);
    if (inBand.length === 0) {
        console.warn(`[BotProfileLoader] No profile in band for elo=${elo} (player=${playerId}). Check JSON.`);
        return null;
    }

    const facedInBand = new Set(
        (alreadyFaced || []).filter(id => inBand.some(p => p.botProfileId === id))
    );
    const unfaced = inBand.filter(p => !facedInBand.has(p.botProfileId));

    // When every profile in the band has been faced, reset the cycle by using
    // the full band again. The caller is expected to clear the `botsFaced`
    // entries for this band on match_end so the cycle starts fresh next time.
    const candidates = unfaced.length > 0 ? unfaced : inBand;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Returns the band names whose every profile is in `faced`. The MatchRoom
 * caller uses this to drop those band entries from the player's `botsFaced`
 * Firestore array on match_end (resetting the rotation for next time).
 */
export function getBandsToReset(faced: string[]): string[] {
    if (!faced || faced.length === 0) return [];
    const bandsTouched = new Set<string>();
    const facedSet = new Set(faced);
    for (const p of _profiles) {
        if (facedSet.has(p.botProfileId)) bandsTouched.add(p.eloBand);
    }
    const reset: string[] = [];
    for (const band of bandsTouched) {
        const inBand = _profiles.filter(p => p.eloBand === band);
        if (inBand.length > 0 && inBand.every(p => facedSet.has(p.botProfileId))) {
            reset.push(band);
        }
    }
    return reset;
}

/** Test/debug helper — exposes the loaded profile count. */
export function getLoadedCount(): number { return _profiles.length; }

function countByBand(list: BotProfile[]): Record<string, number> {
    const out: Record<string, number> = {
        Bronze: 0, Silver: 0, Gold: 0, Platinum: 0, Diamond: 0, Master: 0,
    };
    for (const p of list) if (p.eloBand in out) out[p.eloBand]++;
    return out;
}
