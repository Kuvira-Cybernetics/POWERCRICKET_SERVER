/**
 * Bot catalog reader.
 *
 * Reads `playerCardDefinitions` from Firestore on server start (and every 5 min)
 * and exposes a per-id lookup so BotProfileLoader can resolve a bot profile's
 * playerId list into full TeamPlayer records (name / role / rarity / powerType).
 *
 * The legacy random-pick `buildBotTeam()` function and `FALLBACK_BOT_TEAM` were
 * deleted — bot teams are now sourced from prebuilt profiles via
 * BotProfileLoader. See bot_profiles.json + BotProfileLoader.ts.
 */
import { getDb } from "../../config/firebaseAdmin.js";
import { resolveEffectType } from "../powers/loader.js";

/** Server-side TeamPlayer shape — mirrors the on-wire schema in MatchRoomState.ts. */
export interface BotTeamPlayer {
    playerId:  string;
    name:      string;
    role:      string; // "BattingStrategy" | "BattingDefense" | "BowlingFast" | "BowlingSpin"
    rarity:    string;
    powerType: string;
    basePower: number;
    level:     number;
}

interface CatalogPlayer {
    playerDefId: string;
    playerId:    string;
    playerName:  string;
    role:        string;
    rarity:      string;
    country:     string;   // #3 — used to keep a bot team single-country (never mixed)
    powerIds:    string[];
    isEnabled:   boolean;
}

const COLLECTION                   = "playerCardDefinitions";
const VERSION_DOC_PATH              = { col: "gameVersions", doc: "catalog", field: "playerCardsVersion" } as const;
/** Cheap version-check cadence — reads one tiny doc. */
const VERSION_CHECK_INTERVAL_MS     = 30 * 1000;
/** Safety-net full refresh used when the version doc is unreachable. */
const FALLBACK_REFRESH_INTERVAL_MS  = 5 * 60 * 1000;

let _catalog:           CatalogPlayer[] = [];
let _refreshTimer:      NodeJS.Timeout | undefined;
let _initStarted        = false;
/** Last `playerCardsVersion` we've already pulled. `null` = never read yet. */
let _lastSeenVersion:   number | null = null;
let _lastFullRefreshAt  = 0;

/**
 * Prime the catalog cache and start the periodic refresh. Safe to call once at
 * app start; subsequent calls are no-ops. Awaiting it is optional — first match
 * may briefly miss image fields if Firestore is slow.
 *
 * Refresh strategy: every 30s we read just `gameVersions/catalog.playerCardsVersion`
 * (one tiny doc) and only do a full `playerCardDefinitions` collection pull when
 * the counter has changed. The admin frontend bumps the counter on every write,
 * so live edits propagate within ~30s instead of the legacy 5-minute window.
 */
export async function initBotTeamBuilder(): Promise<void> {
    if (_initStarted) return;
    _initStarted = true;

    await refreshCatalog();
    _lastFullRefreshAt = Date.now();
    _lastSeenVersion = await getServerVersion();

    if (!_refreshTimer) {
        _refreshTimer = setInterval(() => {
            checkAndRefreshIfStale().catch(err =>
                console.warn("[BotTeamBuilder] Version-aware refresh failed (keeping previous catalog):", err));
        }, VERSION_CHECK_INTERVAL_MS);
        _refreshTimer.unref?.();
    }
}

/** One tick: read the cheap version counter, full-refresh only on mismatch. */
async function checkAndRefreshIfStale(): Promise<void> {
    const serverVersion = await getServerVersion();

    if (serverVersion === null) {
        if (Date.now() - _lastFullRefreshAt >= FALLBACK_REFRESH_INTERVAL_MS) {
            await refreshCatalog();
            _lastFullRefreshAt = Date.now();
        }
        return;
    }

    if (_lastSeenVersion === serverVersion) return;

    await refreshCatalog();
    _lastFullRefreshAt = Date.now();
    _lastSeenVersion = serverVersion;
    console.log(`[BotTeamBuilder] Detected version bump → ${serverVersion}; reloaded ${_catalog.length} players.`);
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

async function refreshCatalog(): Promise<void> {
    const db = getDb();
    if (!db) {
        console.warn("[BotTeamBuilder] No Firestore — bot profile playerIds won't resolve to names/roles.");
        return;
    }

    try {
        const snap = await db.collection(COLLECTION).get();
        if (snap.empty) {
            console.warn(`[BotTeamBuilder] ${COLLECTION} empty — bot profile playerIds won't resolve.`);
            _catalog = [];
            return;
        }
        const fresh: CatalogPlayer[] = [];
        snap.forEach(doc => {
            const d: any = doc.data() || {};
            const playerId   = (typeof d.playerId    === "string" && d.playerId)    || (typeof d.playerDefId === "string" && d.playerDefId) || doc.id;
            const playerName = typeof d.playerName === "string" ? d.playerName : "";
            const role       = typeof d.role       === "string" ? d.role       : "";
            const rarity     = typeof d.rarity     === "string" ? d.rarity     : "Common";
            const country    = typeof d.country    === "string" ? d.country    : "";
            const powerIds   = Array.isArray(d.powerIds)
                ? d.powerIds.filter((p: any) => typeof p === "string" && p.length > 0)
                : [];
            const isEnabled  = d.isEnabled !== false; // default true when missing
            if (!playerId || !playerName || !role) return;
            fresh.push({ playerDefId: doc.id, playerId, playerName, role, rarity, country, powerIds, isEnabled });
        });
        _catalog = fresh.filter(p => p.isEnabled);
        const buckets = countByRole(_catalog);
        console.log(`[BotTeamBuilder] Loaded ${_catalog.length} enabled players ` +
            `(BattingStrategy=${buckets.BattingStrategy} BattingDefense=${buckets.BattingDefense} ` +
            `BowlingFast=${buckets.BowlingFast} BowlingSpin=${buckets.BowlingSpin})`);
    } catch (err) {
        console.warn("[BotTeamBuilder] Fetch failed (keeping previous cache):", err);
    }
}

/**
 * Look up a single catalog player by id. Returns null if the catalog hasn't
 * loaded or the id isn't in `playerCardDefinitions`. BotProfileLoader callers
 * use this to expand a profile's playerId arrays into full TeamPlayer records
 * for the Colyseus state schema.
 */
export function getCatalogPlayer(id: string): BotTeamPlayer | null {
    if (!id) return null;
    const c = _catalog.find(p => p.playerId === id);
    if (!c) return null;
    return {
        playerId:  c.playerId,
        name:      c.playerName,
        role:      c.role,
        rarity:    c.rarity,
        // Ship the first power as `powerType`, normalized to its effectType
        // ("power_bait" → "Bait") so buildPowerManifest/getPowerEffect surface bot
        // powers like a human's (humans send EffectTypeKey directly). Client's
        // LivePlayerResolver still fuzzy-matches on (name, role, rarity) to
        // recover the full powers list.
        powerType: resolveEffectType(c.powerIds[0] || ""),
        basePower: 1,
        level:     1,
    };
}

export function getCatalogSize(): number { return _catalog.length; }

/** Internal: CatalogPlayer → BotTeamPlayer (same shape getCatalogPlayer returns). */
function catalogToTeamPlayer(c: CatalogPlayer): BotTeamPlayer {
    return {
        playerId:  c.playerId,
        name:      c.playerName,
        role:      c.role,
        rarity:    c.rarity,
        powerType: resolveEffectType(c.powerIds[0] || ""),
        basePower: 1,
        level:     1,
    };
}

/**
 * #3 — Normalize a bot profile's rosters to a SINGLE country so a bot team never mixes
 * nationalities. Resolves the profile's playerIds, picks the most-common country among them,
 * and substitutes any off-country card with a same-role, same-country card from the catalog
 * (preserving team size + role composition; substituted ids change so the client renders the
 * right flags).
 *
 * Returns null — caller MUST fall back to the original roster — whenever a clean single-country
 * team can't be GUARANTEED: catalog not loaded, no country data on the cards, an id doesn't
 * resolve, or no same-country same-role substitute exists for some slot. Never returns a
 * partial/illegal team to satisfy the constraint.
 */
export function pickSingleCountryRoster(
    battingIds: string[],
    bowlingIds: string[],
): { batting: BotTeamPlayer[]; bowling: BotTeamPlayer[]; country: string; substituted: number } | null {
    const resolve = (id: string): CatalogPlayer | null => _catalog.find(p => p.playerId === id) || null;
    const batCats  = battingIds.map(resolve);
    const bowlCats = bowlingIds.map(resolve);

    const resolved = [...batCats, ...bowlCats].filter((c): c is CatalogPlayer => c !== null);
    if (resolved.length === 0) return null;                  // nothing resolved (stale ids) → fall back

    const withCountry = resolved.filter(c => !!c.country);
    if (withCountry.length === 0) return null;               // no country data → can't normalize → fall back

    // Target country = the most common one among the resolved cards.
    const counts: Record<string, number> = {};
    for (const c of withCountry) counts[c.country] = (counts[c.country] || 0) + 1;
    let target = withCountry[0].country, best = 0;
    for (const ct of Object.keys(counts)) if (counts[ct] > best) { best = counts[ct]; target = ct; }

    const used = new Set<string>();
    let substituted = 0;

    const pickFor = (cat: CatalogPlayer | null): BotTeamPlayer | null => {
        if (!cat) return null;                               // an id didn't resolve → fall back
        used.add(cat.playerId);
        if (!cat.country || cat.country === target) return catalogToTeamPlayer(cat);
        const sub = _catalog.find(p =>
            p.isEnabled && p.country === target && p.role === cat.role && !used.has(p.playerId));
        if (!sub) return null;                               // no same-country same-role sub → fall back
        used.add(sub.playerId);
        substituted++;
        return catalogToTeamPlayer(sub);
    };

    const batting: BotTeamPlayer[] = [];
    for (const cat of batCats)  { const r = pickFor(cat); if (!r) return null; batting.push(r); }
    const bowling: BotTeamPlayer[] = [];
    for (const cat of bowlCats) { const r = pickFor(cat); if (!r) return null; bowling.push(r); }

    return { batting, bowling, country: target, substituted };
}

/**
 * Full catalog record for a playerId — including the 3-power id list.
 *
 * Used by MatchRoom to attach rich card payloads to outbound match messages
 * (select_*_card, innings_start, ball_start). Lets the client render the
 * popup + HUD even when its local StreamingAssets baseline is older than
 * Firestore (i.e. the cardId isn't in the local catalog).
 *
 * Returns null when the catalog hasn't loaded yet or the id is unknown.
 * Caller must tolerate null (omit cardData from the payload in that case).
 */
export interface CatalogPlayerFull {
    playerId:  string;
    name:      string;
    role:      string;
    rarity:    string;
    powerIds:  string[];
    level:     number;
    basePower: number;
}

export function getCatalogPlayerFull(id: string): CatalogPlayerFull | null {
    if (!id) return null;
    const c = _catalog.find(p => p.playerId === id);
    if (!c) return null;
    return {
        playerId:  c.playerId,
        name:      c.playerName,
        role:      c.role,
        rarity:    c.rarity,
        powerIds:  c.powerIds.slice(),
        level:     1,
        basePower: 1,
    };
}

function countByRole(list: CatalogPlayer[]): Record<string, number> {
    const out: Record<string, number> = {
        BattingStrategy: 0, BattingDefense: 0, BowlingFast: 0, BowlingSpin: 0,
    };
    for (const p of list) if (p.role in out) out[p.role]++;
    return out;
}
