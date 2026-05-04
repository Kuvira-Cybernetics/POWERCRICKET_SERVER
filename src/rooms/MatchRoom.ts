import { Room, Client } from "colyseus";
import { ArraySchema } from "@colyseus/schema";
import { onPeerDisconnected } from "@colyseus/webrtc";
import { onlinePlayers } from "../presence.js";
import {
    MatchRoomState, PlayerState, InningsData,
    BallState, TeamPlayer, PowerSlot, PowerUsage,
} from "./schema/MatchRoomState.js";
import { getPowerEffect } from "./powers/loader.js";
import type { IPowerEffect } from "./powers/types.js";
import { getGameConfig, getPatternBoxes } from "../config/gameConfig.js";
import { getDb } from "../config/firebaseAdmin.js";
import { getCatalogPlayer } from "./bots/BotTeamBuilder.js";
import { getProfileById, getBandsToReset } from "./bots/BotProfileLoader.js";
import { log as slog } from "../util/log.js";
import {
    computeWirePosition,
    battingRoleMultiplier,
    bowlingRoleMultiplier,
    type SliderEase,
} from "../util/sliderMath.js";

// ── Generic log silencer ─────────────────────────────────────────────────────
// Drops any console.log / console.warn / console.info that does NOT start with
// the tracer prefix "####_". console.error always passes.
// Flip TRACE_SILENCE_GENERIC=false (env var) to restore verbose logging.
(function installTraceFilter() {
    if (process.env.TRACE_SILENCE_GENERIC === "false") return;
    const prefix = "####_";
    const passes = (args: any[]): boolean => {
        const first = args.length > 0 ? args[0] : "";
        return typeof first === "string" && first.startsWith(prefix);
    };
    const origLog  = console.log;
    const origWarn = console.warn;
    const origInfo = console.info;
    console.log  = (...args: any[]) => { if (passes(args)) origLog.apply(console, args); };
    console.warn = (...args: any[]) => { if (passes(args)) origWarn.apply(console, args); };
    console.info = (...args: any[]) => { if (passes(args)) origInfo.apply(console, args); };
})();

const TOSS_TIMEOUT_MS          = 15_000;
const TOSS_DECISION_TIMEOUT_MS = 10_000;
const CARD_SELECT_TIMEOUT      = 10_000;
const BALL_TIMEOUT_MS          = 8_000;
const PATTERN_SELECT_TIMEOUT   = 8_000;   // 8s for bowler to pick pattern
// Post-ball delay before the next card-select prompt. Must be >= client-side
// ScoreFlashController.HoldSeconds (2s) so the score label finishes animating
// to both players before the next ball's popups appear.
const POST_BALL_NEXT_SELECT_DELAY = 2_500;
// Delay between the final-ball ball_result and the innings_end broadcast so the
// last ball's score flash + HUD update is visible before innings_break / match_end
// tears down the match canvases. Same minimum as the next-select delay.
const POST_BALL_INNINGS_END_DELAY = 2_500;
const CATCH_PHASE_TIMEOUT      = 5_000;   // 5s for fielder to tap
const CATCH_CHANCE_4           = 1.0;     // 100% catch opportunity on 4s
const CATCH_CHANCE_6           = 1.0;     // 100% catch opportunity on 6s
const CATCH_BOX_WIDTH_FAST     = 15.0;    // % of container width
const CATCH_ARC_WIDTH_SPIN     = 12.0;    // % of 360 degrees
const CATCH_SWEEP_SPEED        = 1.0;     // sweeps per second (fast)
const CATCH_ROTATION_SPEED     = 180.0;   // degrees per second (spin)
// Bot difficulty defaults — used only if room is created without options (dev/test).
// Production values come from Firestore gameConfig/match via LobbyRoom → room options.
const DEFAULT_BOT_CATCH_RATE         = 0.1;
const DEFAULT_BOT_WICKET_ZONE_FACTOR = 0.1;

/** Clamp a value to [0,1]. Falls back to `fallback` if input is not a finite number. */
function clamp01(v: any, fallback: number): number {
    if (typeof v !== "number" || !isFinite(v)) return fallback;
    return Math.max(0, Math.min(1, v));
}
// ── Pattern ────────────────────────────────────────────────────────────────
// Single source of truth: Firestore `pattern_boxes_json` via gameConfig.
// Server shuffles those boxes deterministically per ball. No templates,
// no server-side power mutation. Powers are applied client-side via PowerSystem.

interface PatternBox { value: number; width: number; colorHex: string; }
interface InitialPattern { shape: "StraightLine" | "Ring"; boxes: PatternBox[]; }

/** Formats an InitialPattern's boxes as "[1][2][W][4][6][0]" for debug logging. */
function fmtPatternBoxes(boxes: PatternBox[] | undefined | null): string {
    if (!boxes || boxes.length === 0) return "(empty)";
    const label = (v: number): string => {
        if (v === -1) return "W";
        if (v === 0)  return "0";
        return String(v);
    };
    return boxes.map(b => `[${label(b.value)}]`).join("");
}

/** Seeded pseudo-random number generator (Mulberry32) for deterministic patterns. */
function seededRandom(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build a per-ball pattern by shuffling Firestore-defined pattern boxes deterministically.
 * - Box values/widths/colours come from  admin setting (gameConfig).
 * - Shape is derived from bowler type (Fast → StraightLine, Spin → Ring).
 * - No power mutation here — client applies powers before rendering.
 */
function buildInitialPattern(seed: number, bowlerType: string): InitialPattern {
    const shape: "StraightLine" | "Ring" = bowlerType === "spin" ? "Ring" : "StraightLine";
    // getPatternBoxes() guarantees a non-empty array (falls back to built-in
    // defaults when Firestore pattern_boxes_json is missing / malformed).
    const defs = getPatternBoxes();

    const boxes: PatternBox[] = defs.map((d) => ({
        value:    d.value,
        width:    d.widthPercent / 100,
        colorHex: d.color,
    }));

    // Deterministic Fisher-Yates shuffle so bowler-view and startBall see identical order.
    const rng = seededRandom(seed);
    for (let i = boxes.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [boxes[i], boxes[j]] = [boxes[j], boxes[i]];
    }

    return { shape, boxes };
}

// ── ELO Constants ───────────────────────────────────────────────────────────
const ELO_K_FACTOR         = 32;   // Standard K-factor for ELO calculation

// ── Reward Constants ────────────────────────────────────────────────────────
const REWARD_COIN_WIN      = 50;
const REWARD_COIN_LOSS     = 15;
const REWARD_COIN_DRAW     = 30;
const REWARD_XP_WIN        = 30;
const REWARD_XP_LOSS       = 10;
const REWARD_XP_DRAW       = 20;
const REWARD_TROPHY_WIN    = 30;
const REWARD_TROPHY_LOSS   = -20;
const REWARD_TROPHY_DRAW   = 5;

// ── Bot AI Constants ────────────────────────────────────────────────────────
const BOT_SESSION_ID       = "__bot__";
const BOT_RESPONSE_DELAY   = 800; // ms delay to simulate human thinking
const DEBUG_INFINITE_MS    = 2_147_483_647; // ~24.8 days — effectively infinite for testing

// FALLBACK_BOT_TEAM removed in the bot-profile-database migration. The synthetic
// IDs ("bot_bat1", …) didn't resolve in PlayerImageCache and rendered empty
// cards. Bot rosters are now sourced from prebuilt profiles via BotProfileLoader
// (Firestore primary, bundled bot_profiles.json fallback). When no profile is
// available, LobbyRoom rejects the bot match before this room is created.

// ── Power Effect Definitions ─────────────────────────────────────────────
// Power configs now live in src/rooms/powers/ as individual classes.
// Use getPowerEffect(effectType) to get an IPowerEffect instance.
// loadPowerDefinitions() reads from Firestore at startup; falls back to defaults.

/**
 * MatchRoom — room name "match_room"
 * Server-authoritative 1v1 cricket match. Full game loop:
 *   Lobby → Toss → DeckConfirm → Innings 1 → Break → Innings 2 → Result
 */
export class MatchRoom extends Room {
    declare state: MatchRoomState;
    maxClients  = 2;
    autoDispose = true;

    // ── Diagnostic tracer ────────────────────────────────────────────────────
    // Emits a uniquely grep-able line at every network SEND.
    // Format: ####_SRV_<site>_<dir>_<name> | cid=<matchId>:<phase>:<balls>:<seq> k=v k=v ...
    // The cid (correlation id) lets SEND lines here match RECV lines on the client HUD.
    // Toggle off by setting TRACE_ENABLED to false.
    private static TRACE_ENABLED = false;
    private _cidSeq = 0;
    /** Mint a correlation id. Unique per room; ordered; human-readable. */
    private _mintCid(): string {
        const mid    = this.state?.matchId || this.roomId || "m?";
        const phase  = this.state?.phase || "boot";
        const innings = this.currentInnings | 0;
        const balls  = innings > 0 ? (this.state as any)?.[`innings${innings}`]?.ballsBowled ?? 0 : 0;
        return `${mid}:${phase}:${innings}.${balls}:${this._cidSeq++}`;
    }
    private trace(site: string, dir: string, name: string, kv: Record<string, any> = {}): void {
        if (!MatchRoom.TRACE_ENABLED) return;
        const cid = (kv && (kv as any).cid) ? (kv as any).cid : this._mintCid();
        const rest = { cid, ...kv };
        const bits = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(" ");
        console.log(`####_SRV_${site}_${dir}_${name} | ${bits}`);
    }

    // Session IDs of batting / bowling players for each innings
    private battingSid = "";
    private bowlingSid = "";
    private currentInnings = 0;

    // Per-ball state
    private bowlerPlayerId  = "";
    private batsmanPlayerId = "";
    private ballTimer: any = null;

    // ── Bot slider echo ───────────────────────────────────────────────────────
    // Bot doesn't run a WebRTC client, so the human opponent has no P2P slider
    // echo stream to mirror. The server emits `bot_slider_echo` at 20Hz during
    // the bot's active turn (batting tap window or catch attempt window) so the
    // human's viewer pipeline (OpponentEchoManager → PatternController) renders
    // a smooth slider path that lands on the bot's chosen position. Cleared on
    // every exit path (resolve, timeout, onLeave, endMatch, onDispose) BEFORE
    // any outcome broadcast, so stale echoes never arrive after ball_result.
    private botEchoTimer: any = null;

    // Deck confirm tracking
    private teamReadyCount = 0;
    private selectionReadyCount = 0;

    // Super Over tracking
    private isSuperOver        = false;
    private superOverInnings   = 0;   // 1 or 2 during super over
    // Original batting/bowling sids from the main match (preserved for super over role swap)
    private originalBattingSid = "";
    private originalBowlingSid = "";

    // ── Power tracking (per-ball) ────────────────────────────────────────────
    // Powers activated for the current ball. Cleared after each ball resolves.
    private activePowersThisBall: Map<string, { sid: string; cardId: string }> = new Map();
    // Cumulative usage count per key "sessionId:powerType" across the match.
    private powerUsageCount: Map<string, number> = new Map();

    // ── Power state tracking (per innings) ───────────────────────────────────
    // Reset in startInnings; mutated by resolveBall/resolveCatch/applyBundledActivations.
    /**
     * Per-power upgrade level reported by clients in select_bowler / select_batsman.
     * Indexed by powerId (e.g. "power_wicket_master" → 3). Server-side power math
     * (WicketMaster deduction, Defense decrement, Sledge/BL ball counts, SR Master
     * ball count) reads from here. Falls back to Firestore powerDefinitions level
     * (loaded via getPowerEffect), then to 1.
     */
    private powerLevels: Map<string, number> = new Map();
    /** Defense: per-bowler-card cumulative width multiplier (1.0 default, decrements on wicket). */
    private defenseMultiplier: Map<string, number> = new Map();
    /** SR Master: over index where forced-boundary balls fire. -1 = no roll for this innings. */
    private srMasterChosenOver = -1;
    /** SR Master: balls left in chosen over to flag srMasterActiveThisBall=true. */
    private srMasterBallsRemaining = 0;
    /** Sledge: free-hit balls remaining (no wicket / no catch). */
    private sledgeBallsRemaining = 0;
    /** Boundary Legend: forced-boundary balls remaining. */
    private boundaryLegendBallsRemaining = 0;
    /** Boundary Legend: armed for next-ball auto-wicket once forced-boundary span ends. */
    private boundaryLegendAutoWicketArmed = false;
    /** ExtraBall: granted-once-per-over flag (resets when over actually completes). */
    private extraBallGrantedThisOver = false;
    /** CenturyMaster: granted-once-per-innings flag. */
    private centuryMasterGrantedThisInnings = false;
    /** Sum of bonus balls granted (ExtraBall/CenturyMaster) in current innings — adjusts modulo math. */
    private bonusBallsAccumulated = 0;
    /** First over of each innings = power play (simple rule). */
    private powerPlayOverIndex = 0;

    // ── Toss timeout timer ───────────────────────────────────────────────────
    private tossTimer: any = null;

    // ── Match duration tracking ──────────────────────────────────────────────
    private matchStartedAt = 0;

    // ── Rematch tracking ─────────────────────────────────────────────────────
    // rematchPhase: "" | "pending" | "accepted" | "declined"
    //   "pending"  — requester has sent rematch_request; waiting on opponent reply.
    //   "accepted" — both players accepted; resetRoomForRematch() is running.
    //   "declined" — a decline/timeout/disconnect was broadcast; room will dispose.
    private rematchPhase = "";
    private rematchRequestedBy = "";           // sessionId of the requester
    private rematchResponses = new Map<string, boolean>();
    private rematchTimer: any = null;          // 20s opponent-response timeout
    // Replaces the old inline 5s timer at the bottom of endMatch(). We keep a handle
    // so handleRematchRequest can cancel it and the room stays alive while the
    // rematch handshake resolves. Restarted (short) on decline/timeout.
    private matchEndDisposeTimer: any = null;

    // ── Debug ────────────────────────────────────────────────────────────────
    /** When true, all server-side action timers use ~infinite timeout so the
     *  match waits for player input indefinitely. Set via room option. */
    private debugSkipTimers = false;
    /** Session ID of the player who requested debugForceWinToss (empty = disabled). */
    private debugForceWinSid = "";

    // ── Player 1 (room creator) ─────────────────────────────────────────────
    private player1Sid = "";   // First human player to join = P1

    // ── Bot tracking ─────────────────────────────────────────────────────────
    private isBot      = false;
    private botSid     = "";   // Session ID of the bot "player"
    // Bot difficulty — resolved from room options at onCreate (admin-controlled via Firestore).
    private botCatchRate         = DEFAULT_BOT_CATCH_RATE;
    private botWicketZoneFactor  = DEFAULT_BOT_WICKET_ZONE_FACTOR;
    // Profile-driven bot identity + roster. Picked by LobbyRoom.createBotMatch
    // and passed in via onCreate options. Empty string = not a bot match.
    private botProfileId         = "";
    // Persistent identity of the human player in this bot match. Used to write
    // the chosen botProfileId back into the player's `botsFaced` Firestore
    // array on match_end so rotation can pick an unfaced bot next time.
    private humanPlayerId        = "";

    // ── Bowler pattern choice tracking ───────────────────────────────────────
    private patternSeed          = 0;
    private chosenPatternIndex   = 0;
    private currentBowlerType    = "fast";
    // Broadcast arrowSpeed for the current ball. Server ships the base value;
    // client's PowerSystem applies any speed modifiers (EagleEye, SuperFastBall,
    // etc.) before the slider renders. Used by scheduleBotAction to compute a
    // bot tap position that matches the slider oscillation at tap time.
    private currentBallBroadcastArrowSpeed = 1;

    // ── Parallel power-select tracking (per-ball) ────────────────────────────
    // Tracks which side has confirmed their power selection for the current ball.
    // Both must confirm before promptBowlerPattern fires.
    private cardSelectsPending: { bowler: boolean; batsman: boolean } = { bowler: false, batsman: false };
    // Powers activated via the bundled select_bowler/select_batsman reply
    // (not via independent power_activate message).
    private pendingBundledPowers: { bowler: string[]; batsman: string[] } = { bowler: [], batsman: [] };
    // Tracks overs bowled per bowler card for the 2-over cap rule.
    private bowlerOversBowled: Map<string, number> = new Map();
    // Which bowler is bowling the CURRENT over (locked for 6 balls).
    private currentOverBowlerId = "";

    // ── Catch phase tracking ─────────────────────────────────────────────────
    private lastBatsmanTapPosition = 0;
    private pendingCatchResult: {
        value: number; runs: number; originalRuns: number;
        outcome: string; powersApplied: string;
        battingSid: string; bowlingSid: string;
    } | null = null;

    // ── Lifecycle ───────────────────────────────────────────────────────────

    onCreate(options: any) {
        // Live game config (admin-editable via Firestore). Used to derive match rules
        // so changes from the admin site take effect on the next match without redeploy.
        const cfg = getGameConfig();

        this.state = new MatchRoomState();
        this.state.matchId        = options.matchId    || this.roomId;
        this.state.oversPerMatch  = options.oversPerMatch ?? cfg.oversPerMatch;
        this.state.ballsPerOver   = options.ballsPerOver  ?? cfg.ballsPerOver;
        // state.maxWickets is set per-innings in startInnings() from battingPlayers.length - 1.
        this.state.superOverEnabled = options.superOverEnabled ?? cfg.superOverEnabled;
        this.state.isPrivate      = options.isPrivate     || false;
        this.state.roomCode       = options.roomCode      || "";
        this.state.createdAt      = Date.now();
        this.isBot                = options.isBot         || false;
        this.botCatchRate         = clamp01(options.botCatchRate,        DEFAULT_BOT_CATCH_RATE);
        this.botWicketZoneFactor  = clamp01(options.botWicketZoneFactor, DEFAULT_BOT_WICKET_ZONE_FACTOR);
        this.botProfileId         = options.botProfileId  || "";
        this.humanPlayerId        = options.humanPlayerId || "";
        this.debugSkipTimers      = options.debugSkipTimers || false;
        if (this.debugSkipTimers) slog("MatchRoom", "debug_skip_timers", { roomId: this.roomId });

        // Power definitions are loaded once at server startup (app.config.ts).
        // No per-room reload needed.

        this.onMessage("toss_choice",    (c, m) => this.handleTossChoice(c, m));
        this.onMessage("toss_bat_bowl",  (c, m) => this.handleTossBatBowl(c, m));
        this.onMessage("deck_confirm",   (c, m) => this.handleDeckConfirm(c, m));
        this.onMessage("player_ready",   (c, m) => this.handlePlayerReady(c, m));
        this.onMessage("select_bowler",  (c, m) => this.handleSelectBowler(c, m));
        this.onMessage("select_batsman", (c, m) => this.handleSelectBatsman(c, m));
        this.onMessage("batsman_tap",    (c, m) => this.handleBatsmanTap(c, m));
        this.onMessage("power_activate",        (c, m) => this.handlePowerActivate(c, m));
        this.onMessage("bowler_pattern_choice", (c, m) => this.handleBowlerPatternChoice(c, m));
        // Bowler-client-authoritative pattern pipeline: bowler's device ships the
        // final post-power pattern here. Server rebroadcasts it verbatim via ball_start.
        this.onMessage("bowler_chosen_pattern", (c, m) => this.handleBowlerChosenPattern(c, m));
        this.onMessage("fielder_tap",           (c, m) => this.handleFielderTap(c, m));
        this.onMessage("extra_ball_request",    (c, m) => this.handleExtraBallRequest(c, m));
        this.onMessage("forfeit",               (c)    => this.handleForfeit(c));
        this.onMessage("heartbeat",      (c)    => c.send("heartbeat_ack", {}));

        // ── Rematch ───────────────────────────────────────────────────────────
        this.onMessage("rematch_request",  (c)    => this.handleRematchRequest(c));
        this.onMessage("rematch_response", (c, m) => this.handleRematchResponse(c, m));
        this.onMessage("rematch_cancel",   (c)    => this.cancelRematch("declined", c.sessionId));

        // ── Voice (WebRTC) ────────────────────────────────────────────────────
        // Audio itself flows P2P via WebRTC AudioStreamTrack — the server only
        // relays the "speaking" indicator for UI.
        this.onMessage("voice_speaking", (client, msg: { speaking: boolean }) => {
            const player = this.state.players.get(client.sessionId);
            if (player) player.isSpeaking = !!msg?.speaking;
            this.broadcast("opponent_speaking", { speaking: !!msg?.speaking }, { except: client });
        });

        // ── WebRTC Signaling (@colyseus/webrtc) ──────────────────────────────
        // Relay SDP offers/answers and ICE candidates between peers for P2P setup.
        // DataChannels carry voice + game echo (arrow position, tap flash) directly
        // between clients, bypassing the server for lower latency.

        this.onMessage("webrtc:join", (client) => {
            const peerIds = this.clients
                .map((c: Client) => c.sessionId)
                .filter((id: string) => id !== client.sessionId);
            client.send("webrtc:peers", peerIds);
            this.broadcast("webrtc:peer-joined", client.sessionId, { except: client });
        });

        this.onMessage("webrtc:offer", (client, message: { targetId: string; sdp: any }) => {
            const target = this.clients.getById(message.targetId);
            target?.send("webrtc:offer", { peerId: client.sessionId, sdp: message.sdp });
        });

        this.onMessage("webrtc:answer", (client, message: { targetId: string; sdp: any }) => {
            const target = this.clients.getById(message.targetId);
            target?.send("webrtc:answer", { peerId: client.sessionId, sdp: message.sdp });
        });

        this.onMessage("webrtc:ice-candidate", (client, message: { targetId: string; candidate: any }) => {
            const target = this.clients.getById(message.targetId);
            target?.send("webrtc:ice-candidate", { peerId: client.sessionId, candidate: message.candidate });
        });

        // If bot match, inject a virtual bot player after a short delay
        if (this.isBot) {
            this.clock.setTimeout(() => this.injectBot(options), 500);
        }
    }

    async onJoin(client: Client, options: any) {
        const p             = new PlayerState();
        p.sessionId         = client.sessionId;
        p.playerId          = options.playerId   || client.sessionId;
        p.name              = options.playerName || "Player";
        p.elo               = options.elo        || 1000;
        p.teamId            = options.teamId || options.deckId || "";
        p.connected         = true;

        // --- Server-side profile lookup (anti-spoof) ---
        // Plan: clients send only uid; server reads displayName + photoUrl from
        // Firestore. Falls back to client-supplied playerName if Firestore
        // unavailable (dev) or doc missing (first-time join before profile write).
        p.displayName = p.name;
        p.avatarUrl   = "";
        try {
            const db = getDb();
            if (db && p.playerId && !p.playerId.startsWith("bot_")) {
                const snap = await db.collection("players").doc(p.playerId).get();
                if (snap.exists) {
                    const data = snap.data() || {};
                    if (typeof data.displayName === "string" && data.displayName.length > 0) {
                        p.displayName = data.displayName;
                        p.name        = data.displayName; // keep legacy `name` in sync
                    }
                    if (typeof data.photoUrl === "string") {
                        p.avatarUrl = data.photoUrl;
                    }
                }
            }
        } catch (err: any) {
            console.warn(`####_[MatchRoom] Firestore profile lookup failed for ${p.playerId}: ${err?.message || err}`);
        }

        this.state.players.set(client.sessionId, p);

        // First human player to join = P1 (room creator)
        if (!this.player1Sid) this.player1Sid = client.sessionId;

        // Debug: if this player requested force-win-toss, record their session ID
        if (options.debugForceWinToss) {
            this.debugForceWinSid = client.sessionId;
            slog("MatchRoom", "debug_force_win_toss", { name: p.name, sid: client.sessionId });
        }

        // Debug: if ANY player requested skip-timers, enable it room-wide
        if (options.debugSkipTimers && !this.debugSkipTimers) {
            this.debugSkipTimers = true;
            slog("MatchRoom", "debug_skip_timers_requested", { name: p.name, sid: client.sessionId });
        }

        // Mark player as online (use jwtToken if provided, else playerId)
        const userId = options.jwtToken || p.playerId;
        onlinePlayers.add(userId);

        this.trace("onJoin", "SEND", "player_joined", { playerId: p.playerId, name: p.name, elo: p.elo });
        // Include displayName + avatarUrl so opponent UI can render profile immediately.
        this.broadcast("player_joined", {
            playerId:    p.playerId,
            playerName:  p.name,
            displayName: p.displayName,
            avatarUrl:   p.avatarUrl,
            elo:         p.elo,
        });

        // For bot matches, we start toss when the single human player joins (bot is virtual)
        // For normal matches, start when 2 real clients connect
        const playerCount = this.state.players.size;
        if (this.isBot && playerCount >= 2) {
            this.startToss();
        } else if (!this.isBot && this.clients.length === 2) {
            this.startToss();
        }
    }

    onLeave(client: Client, code?: number) {
        const p = this.state.players.get(client.sessionId);
        if (!p) return;
        p.connected = false;
        // Human disconnect in a bot match ends the match — stop feeding echoes.
        if (this.isBot) this.clearBotEchoTimer();

        // Remove from online presence (bot sessions are excluded)
        if (!p.playerId.startsWith("bot_")) {
            onlinePlayers.delete(p.playerId);
        }

        this.trace("onLeave", "SEND", "player_disconnected", { playerId: p.playerId, graceSeconds: 30 });
        this.broadcast("player_disconnected", { playerId: p.playerId, graceSeconds: 30 });

        // Notify WebRTC peers that this client disconnected
        onPeerDisconnected(this, client);

        // If a rematch handshake is live, notify both sides before normal teardown.
        // cancelRematch broadcasts "rematch_declined" and schedules a short dispose.
        if (this.rematchPhase === "pending") {
            this.cancelRematch("disconnected", client.sessionId);
            return;
        }

        // Bot match with the only human leaving — forfeit immediately, no grace period.
        // The bot isn't waiting for anyone, and keeping the room alive while the bot finishes
        // all remaining balls just wastes a room slot.
        if (this.isBot && this.state.phase !== "result") {
            this.endMatch(this.botSid, client.sessionId, "abandoned");
            return;
        }

        // Toss phase has a 10s server timeout anyway; 30s grace during toss makes no sense.
        if (this.state.phase === "toss_call" || this.state.phase === "toss_decision") {
            this.endMatch(this.opponentOf(client.sessionId), client.sessionId, "disconnect");
            return;
        }

        this.allowReconnection(client, 30)
            .then(() => {
                const rp = this.state.players.get(client.sessionId);
                if (rp) rp.connected = true;
                this.trace("onJoinReconnect", "SEND", "player_reconnected", { playerId: rp?.playerId });
                this.broadcast("player_reconnected", { playerId: rp?.playerId });
            })
            .catch(() => this.endMatch(this.opponentOf(client.sessionId), client.sessionId, "disconnect"));
    }

    /** Returns `ms` as-is, or a near-infinite value when debug timers are disabled. */
    private t(ms: number): number {
        return this.debugSkipTimers ? DEBUG_INFINITE_MS : ms;
    }

    onDispose() {
        this.ballTimer?.clear();
        this.tossTimer?.clear();
        this.rematchTimer?.clear();
        this.matchEndDisposeTimer?.clear();
        this.clearBotEchoTimer();
        slog("MatchRoom", "disposed", { roomId: this.roomId });
    }

    // ── Toss ────────────────────────────────────────────────────────────────

    private startToss() {
        this.matchStartedAt = Date.now();

        // Pick toss winner — forced if debug flag set, otherwise random.
        const keys   = Array.from(this.state.players.keys());
        const winSid = this.debugForceWinSid && keys.includes(this.debugForceWinSid)
            ? this.debugForceWinSid
            : keys[Math.floor(Math.random() * 2)];
        const winner = this.state.players.get(winSid)!;

        this.state.tossCaller = this.player1Sid;
        this.state.tossWinner = winSid;
        this.state.phase      = "toss_decision";

        // P1 = room creator (always), regardless of who wins the toss
        const p1 = this.state.players.get(this.player1Sid)!;

        // Broadcast toss_screen so the client can set up player panels
        this.trace("startToss", "SEND", "toss_screen", { callerId: p1.playerId, callerName: p1.name });
        this.broadcast("toss_screen", {
            callerId: p1.playerId, callerName: p1.name, timeoutSeconds: 0,
        });

        // Immediately broadcast the result — coin flip is purely cosmetic
        // When force-win is active, align the coin face with the winner's side
        // so the client display is consistent (P1/caller = heads, P2 = tails).
        const coin = this.debugForceWinSid
            ? (winSid === this.player1Sid ? "heads" : "tails")
            : (Math.random() < 0.5 ? "heads" : "tails");
        this.trace("startToss", "SEND", "toss_result", { coin, winnerId: winner.playerId, winnerName: winner.name });
        this.broadcast("toss_result", {
            coinResult: coin, callerCall: coin, // caller "called" the winning side (cosmetic)
            winnerId: winner.playerId, winnerName: winner.name,
            message: `${winner.name} won the toss!`,
        });

        // Toss decision timeout — auto-pick "bat" if winner doesn't respond
        this.tossTimer = this.clock.setTimeout(() => {
            if (this.state.phase === "toss_decision") {
                slog("MatchRoom", "toss_decision_timeout", { winSid, autoPick: "bat" });
                this.handleTossBatBowlInternal(winSid, "bat");
            }
        }, this.t(TOSS_DECISION_TIMEOUT_MS));

        // Bot auto-responds to bat/bowl decision
        if (this.isBot && winSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (this.state.phase === "toss_decision") {
                    this.handleTossBatBowlInternal(this.botSid, Math.random() < 0.5 ? "bat" : "bowl");
                }
            }, BOT_RESPONSE_DELAY);
        }
    }

    /** @deprecated Kept for backward compat — server no longer requires a toss_choice message. */
    private handleTossChoice(_client: Client, _msg: { choice: string }) {
        // No-op: heads/tails selection removed. The server picks a random winner directly.
    }

    private handleTossBatBowl(client: Client, msg: { choice: string }) {
        if (this.state.phase !== "toss_decision") return;
        if (client.sessionId !== this.state.tossWinner) return;
        this.handleTossBatBowlInternal(client.sessionId, msg.choice);
    }

    private handleTossBatBowlInternal(winnerSid: string, choice: string) {
        if (this.state.phase !== "toss_decision") return;
        this.tossTimer?.clear();

        this.state.tossChoice = choice;
        if (choice === "bat") {
            this.battingSid = winnerSid;
            this.bowlingSid = this.opponentOfSid(winnerSid);
        } else {
            this.bowlingSid = winnerSid;
            this.battingSid = this.opponentOfSid(winnerSid);
        }

        const batter = this.state.players.get(this.battingSid)!;
        const bowler = this.state.players.get(this.bowlingSid)!;
        const winner = this.state.players.get(this.state.tossWinner)!;

        this.state.phase        = "player_selection";
        this.selectionReadyCount = 0;
        this.trace("handleTossBatBowlInternal", "SEND", "toss_decision", { winnerId: winner.playerId, choice, battingPlayerId: batter.playerId, bowlingPlayerId: bowler.playerId });
        this.broadcast("toss_decision", {
            winnerId: winner.playerId, winnerName: winner.name, choice,
            battingPlayerId: batter.playerId, bowlingPlayerId: bowler.playerId,
        });

        // Bot auto-readies after a short delay
        if (this.isBot) {
            this.clock.setTimeout(() => this.botPlayerReady(), BOT_RESPONSE_DELAY * 2);
        }
    }

    // ── Deck Confirm ────────────────────────────────────────────────────────

    private handleDeckConfirm(client: Client, msg: { deckId?: string; teamId?: string; battingCards?: any[]; bowlingCards?: any[]; battingPlayers?: any[]; bowlingPlayers?: any[] }) {
        // Block during/after innings — phase guard prevents stale retransmits from
        // corrupting team rosters mid-match. Otherwise allow lobby/toss/player_selection.
        const phase = this.state.phase;
        if (phase === "innings1" || phase === "innings2" || phase === "innings_break" || phase === "super_over" || phase === "result") return;
        const player = this.state.players.get(client.sessionId);
        if (!player || player.ready) return;

        // Support both old (battingCards/bowlingCards) and new (battingPlayers/bowlingPlayers) field names
        const bc = msg.battingPlayers || msg.battingCards || [];
        const bw = msg.bowlingPlayers || msg.bowlingCards || [];

        // Smoke #2 diagnostic: log received batting order so we can compare with
        // client's `####_LINEUP_BATSMAN_SEND` log. If they match here but innings
        // start picks the wrong striker, the order is mutated downstream.
        const bcOrder = bc.map((c: any) => `${c?.name ?? "?"}(${c?.playerId ?? "?"})`).join(",");
        console.log(`####_LINEUP_BATSMAN_RECV sid=${client.sessionId} battingCount=${bc.length} order=[${bcOrder}]`);

        // ── Server-side team validation ──
        // Batting minimum comes from admin-tunable config. maxWickets is derived per-innings
        // as (battingCards - 1), so allowing fewer batting cards shortens the innings.
        // Example: config says 3 batting players required → maxWickets = 2.
        const cfg = getGameConfig();
        const minBat  = Math.max(2, cfg.requiredBattingPlayers);   // hard floor of 2 (can't bat solo)
        const minBowl = Math.max(2, cfg.minBowlingPlayers);

        // AUTO-PAD: if a client submitted a legacy team with fewer batsmen than the current
        // config requires, pad with generic fallback batsmen so existing saved teams keep
        // working without forcing a rebuild. Ends the 1-wicket-match bug immediately.
        // Loud log when triggered so the user knows their saved team is undersized for
        // the current admin config and should be rebuilt in TeamBuilder.
        if (bc.length < minBat) {
            const before = bc.length;
            console.error(`####_FALLBACK_HUMAN_BATTING_PAD sid=${client.sessionId} have=${before} required=${minBat} — saved team undersized; padding with auto_batN. User should rebuild team.`);
            while (bc.length < minBat) {
                const idx = bc.length + 1;
                bc.push({
                    playerId: `auto_bat${idx}`,
                    name: `Reserve Batsman ${idx}`,
                    role: "BattingStrategy",
                    rarity: "Common",
                    powerType: "",
                    basePower: 1,
                    level: 1,
                });
                this.trace("handleDeckSubmit", "INFO", "padded_batting", { addedId: `auto_bat${idx}`, newCount: bc.length, required: minBat });
            }
        }
        if (bw.length < minBowl) {
            const before = bw.length;
            console.error(`####_FALLBACK_HUMAN_BOWLING_PAD sid=${client.sessionId} have=${before} required=${minBowl} — saved team undersized; padding with auto_bowN. User should rebuild team.`);
            while (bw.length < minBowl) {
                const idx = bw.length + 1;
                bw.push({
                    playerId: `auto_bow${idx}`,
                    name: `Reserve Bowler ${idx}`,
                    role: idx === 1 ? "BowlingFast" : "BowlingSpin",
                    rarity: "Common",
                    powerType: "",
                    basePower: 1,
                    level: 1,
                });
                this.trace("handleDeckSubmit", "INFO", "padded_bowling", { addedId: `auto_bow${idx}`, newCount: bw.length, required: minBowl });
            }
        }

        // Bowling composition rules: min 1 Fast, max 2 Spin
        const fastCount = bw.filter((c: any) => (c.role || "").includes("Fast")).length;
        const spinCount = bw.filter((c: any) => (c.role || "").includes("Spin")).length;
        if (fastCount < 1) {
            this.trace("handleDeckSubmit", "SEND", "deck_invalid", { reason: "no_fast" });
            client.send("deck_invalid", { error: "You need at least 1 Fast bowler." });
            return;
        }
        if (spinCount > 2) {
            this.trace("handleDeckSubmit", "SEND", "deck_invalid", { reason: "too_many_spin", spinCount });
            client.send("deck_invalid", { error: "Maximum 2 Spin bowlers allowed." });
            return;
        }

        const toPlayer = (c: any): TeamPlayer => {
            const p       = new TeamPlayer();
            p.playerId    = c.playerId  || c.cardId    || "";
            p.name        = c.name      || "";
            p.role        = c.role      || "";
            p.rarity      = c.rarity    || "";
            p.powerType   = c.powerType || "";
            p.basePower   = c.basePower || 1;
            p.level       = c.level     || 1;
            return p;
        };

        player.teamId          = msg.teamId || msg.deckId || "";
        player.battingPlayers  = new ArraySchema<TeamPlayer>(...bc.map(toPlayer));
        player.bowlingPlayers  = new ArraySchema<TeamPlayer>(...bw.map(toPlayer));
        player.ready        = true;

        this.trace("handleDeckConfirm", "INFO", "team_populated", {
            sessionId: client.sessionId, playerId: player.playerId,
            batting: player.battingPlayers.length, bowling: player.bowlingPlayers.length, phase,
        });
        // NOTE: innings start is driven by handlePlayerReady → startMatchAfterSelection
        // (player_selection phase). This handler is now a pure team-population endpoint.
    }

    // ── Player Selection (post-toss) ───────────────────────────────────────

    private handlePlayerReady(client: Client, msg: { selectedPlayerIds?: string[] }) {
        if (this.state.phase !== "player_selection") return;
        const player = this.state.players.get(client.sessionId);
        if (!player || player.selectionReady) return;

        player.selectionReady = true;
        this.selectionReadyCount++;

        slog("MatchRoom", "player_ready", { name: player.name, ready: this.selectionReadyCount, total: 2 });

        // Notify opponent that this player is ready
        const oppSid = this.opponentOfSid(client.sessionId);
        const oppClient = this.clients.find(c => c.sessionId === oppSid);
        this.trace("handlePlayerReady", "SEND", "opponent_ready", { to: oppSid });
        oppClient?.send("opponent_ready", {});

        if (this.selectionReadyCount >= 2) {
            this.startMatchAfterSelection();
        }
    }

    /** Bot auto-selects players and readies up during player_selection phase. */
    private botPlayerReady() {
        if (this.state.phase !== "player_selection") return;
        const bot = this.state.players.get(this.botSid);
        if (!bot || bot.selectionReady) return;

        bot.selectionReady = true;
        this.selectionReadyCount++;

        slog("MatchRoom", "bot_ready", { name: bot.name, ready: this.selectionReadyCount, total: 2 });

        // Notify human player
        const humanSid = this.opponentOfSid(this.botSid);
        const humanClient = this.clients.find(c => c.sessionId === humanSid);
        this.trace("botPlayerReady", "SEND", "opponent_ready", { to: humanSid, from: "bot" });
        humanClient?.send("opponent_ready", {});

        if (this.selectionReadyCount >= 2) {
            this.startMatchAfterSelection();
        }
    }

    /** Both players ready — broadcast and start innings. */
    private startMatchAfterSelection() {
        const batter = this.state.players.get(this.battingSid)!;
        const bowler = this.state.players.get(this.bowlingSid)!;

        this.trace("startMatchAfterSelection", "SEND", "both_players_ready", { battingPlayerId: batter.playerId, bowlingPlayerId: bowler.playerId });
        this.broadcast("both_players_ready", {
            battingPlayerId: batter.playerId,
            bowlingPlayerId: bowler.playerId,
        });

        // Move to deck_confirm phase to validate teams, then start innings
        // If teams are already confirmed from pre-toss lobby, start directly
        this.startInnings(1);
    }

    // ── Innings ─────────────────────────────────────────────────────────────

    private startInnings(num: number) {
        this.currentInnings = num;
        const batting = num === 1 ? this.battingSid : this.bowlingSid;
        const bowling = num === 1 ? this.bowlingSid : this.battingSid;

        const innings = num === 1 ? this.state.innings1 : this.state.innings2;
        innings.battingPlayerId = this.state.players.get(batting)!.playerId;
        innings.bowlingPlayerId = this.state.players.get(bowling)!.playerId;
        innings.balls           = new ArraySchema<BallState>();
        innings.target          = num === 2 ? this.state.innings1.score + 1 : -1;

        // Safety pad: some code paths (legacy teams, direct bot injection) populate
        // battingPlayers without going through handleDeckConfirm's auto-pad. If the roster
        // is under the configured minimum, top it up here so maxWickets never collapses to 1.
        const cfgMW = getGameConfig();
        const minBatMW = Math.max(2, cfgMW.requiredBattingPlayers);
        const battingPlayer = this.state.players.get(batting);

        // Diagnostic: log batting team's roster state BEFORE the safety pad runs.
        // Surfaces P0-3 root cause when bot.battingPlayers arrives empty/short. Padding
        // here pushes `reserve_bat1` placeholders that propagate into BowlerComputeBundle
        // and ball_start, blanking powers and HUD images. `####_` prefix passes the
        // trace filter at the top of this file (otherwise console.log is silenced).
        const _preIds = battingPlayer?.battingPlayers
            ? Array.from(battingPlayer.battingPlayers).map((c: TeamPlayer) => c.playerId).join(",")
            : "(no battingPlayer)";
        console.log(`####_DBG_BOT_ROSTER_AT_INNINGS innings=${num} battingSid=${batting} isBot=${this.isBot && batting === this.botSid} count=${battingPlayer?.battingPlayers?.length ?? 0} required=${minBatMW} ids=[${_preIds}]`);

        if (battingPlayer && (battingPlayer.battingPlayers?.length ?? 0) < minBatMW) {
            const existing = battingPlayer.battingPlayers?.length ?? 0;
            const isBotBatting = this.isBot && batting === this.botSid;

            if (isBotBatting) {
                // Refuse to pad bot rosters. A short bot roster means the bot
                // profile references playerCardDefinitions ids that don't resolve
                // through getCatalogPlayer — a DATA bug (missing Firestore entries)
                // that should be exposed, not masked with reserve_batN placeholders.
                // Match proceeds with the short roster; maxWickets clamps to roster
                // size and the innings ends naturally. The error log below tells the
                // admin exactly which seed step is missing.
                console.error(`####_FALLBACK_BOT_ROSTER_SHORT innings=${num} botSid=${batting} have=${existing} required=${minBatMW}. Refusing to pad. Seed missing playerCardDefinitions / fix bot_profiles.json. Match will run with short roster.`);
                this.trace("startInnings", "ERROR", "bot_roster_short_refused_pad", {
                    innings: num, battingSid: batting,
                    have: existing, required: minBatMW,
                });
            } else {
                // Human-team padding stays as defense. Real human players can
                // legitimately end up short via legacy team data / direct
                // injection paths, and we want the match to still play out.
                for (let i = existing; i < minBatMW; i++) {
                    const reserve = new TeamPlayer();
                    reserve.playerId  = `reserve_bat${i + 1}`;
                    reserve.name      = `Reserve Batsman ${i + 1}`;
                    reserve.role      = "BattingStrategy";
                    reserve.rarity    = "Common";
                    reserve.powerType = "";
                    reserve.basePower = 1;
                    reserve.level     = 1;
                    battingPlayer.battingPlayers.push(reserve);
                }
                this.trace("startInnings", "INFO", "padded_batting_at_start", {
                    innings: num, battingSid: batting,
                    before: existing, after: battingPlayer.battingPlayers.length, required: minBatMW,
                });
                console.log(`####_[MatchRoom] Innings ${num} — padded HUMAN batting roster ${existing}→${battingPlayer.battingPlayers.length} (min=${minBatMW}). This pushes 'reserve_batN' placeholders into the pipeline.`);
            }
        }

        // Compute maxWickets from the batting team's actual batting card count.
        // Cricket rule: the last batsman can't bat alone → maxWickets = battingCards - 1.
        // Example: 3 batting cards → 2 wickets end the innings. Hard floor of 2 so a
        // freak roster can never produce a 1-wicket innings.
        const battingCardCount = battingPlayer?.battingPlayers?.length ?? 0;
        this.state.maxWickets = Math.max(2, battingCardCount - 1);
        this.trace("startInnings", "INFO", "maxWickets_derived", {
            innings: num,
            battingSid: batting,
            battingCardCount,
            maxWickets: this.state.maxWickets,
        });
        // `####_` prefix required to pass the trace filter (top of file).
        console.log(`####_[MatchRoom] Innings ${num} — batting team has ${battingCardCount} batsmen → maxWickets=${this.state.maxWickets}`);

        this.state.phase = `innings${num}`;

        // Reset per-innings bowler tracking on innings 2. The bowling team has changed
        // (innings 1's batting team now bowls), so any state keyed by playerId from
        // innings 1 is stale. Mirrors the cleanup in resetRoomForRematch.
        if (num === 2) {
            this.bowlerOversBowled.clear();
            this.currentOverBowlerId = "";
            console.log(`[MatchRoom] Innings 2 — cleared bowlerOversBowled + currentOverBowlerId`);
        }

        // ── Per-innings power state reset ────────────────────────────────────
        this.defenseMultiplier.clear();
        this.powerLevels.clear();
        this.srMasterChosenOver         = -1;
        this.srMasterBallsRemaining     = 0;
        this.sledgeBallsRemaining       = 0;
        this.boundaryLegendBallsRemaining = 0;
        this.boundaryLegendAutoWicketArmed = false;
        this.extraBallGrantedThisOver   = false;
        this.centuryMasterGrantedThisInnings = false;
        this.bonusBallsAccumulated      = 0;
        this.powerPlayOverIndex         = 0; // first over of every innings is PP

        // ── SR Master: roll a random over once per innings if any batsman has it ──
        const battingTeamForRoll = this.state.players.get(batting);
        const battingHasSRMaster = !!battingTeamForRoll?.battingPlayers?.some(
            (c: TeamPlayer) => c.powerType === "SRMaster"
        );
        if (battingHasSRMaster) {
            const totalOvers = this.isSuperOver ? 1 : this.state.oversPerMatch;
            this.srMasterChosenOver     = Math.floor(Math.random() * totalOvers);
            this.srMasterBallsRemaining = 1 + this.getLevelForEffect("SRMaster"); // L1=2, L2=3, L3=4, L4=5
            console.log(`####_PWR_SRV_SRMASTER_ROLL innings=${num} over=${this.srMasterChosenOver} balls=${this.srMasterBallsRemaining}`);
        }

        // Card IDs for the live player triple (striker / non-striker / bowler) — drives
        // client HUD player display. Striker = battingPlayers[0], non-striker = [1],
        // bowler = first pick from the bowling team's bowlingPlayers roster.
        const startBattingTeam = this.state.players.get(batting);
        const startBowlingTeam = this.state.players.get(bowling);
        const strikerCardId    = startBattingTeam?.battingPlayers?.[0]?.playerId || "";
        const nonStrikerCardId = startBattingTeam?.battingPlayers?.[1]?.playerId || "";
        const bowlerCardId     = startBowlingTeam?.bowlingPlayers?.[0]?.playerId || "";
        this.trace("startInnings", "SEND", "innings_start", { inningsNumber: num, isSuperOver: false, battingPlayerId: innings.battingPlayerId, bowlingPlayerId: innings.bowlingPlayerId, target: innings.target, oversPerInnings: this.state.oversPerMatch, strikerCardId, nonStrikerCardId, bowlerCardId });
        this.broadcast("innings_start", {
            inningsNumber: num, isSuperOver: false,
            battingPlayerId: innings.battingPlayerId, bowlingPlayerId: innings.bowlingPlayerId,
            target: innings.target, oversPerInnings: this.state.oversPerMatch,
            strikerCardId, nonStrikerCardId, bowlerCardId,
        });
        this.clock.setTimeout(() => this.promptBothPowerSelection(batting, bowling), this.t(1500));
    }

    // ── Super Over ───────────────────────────────────────────────────────────

    /**
     * Initiates a Super Over when the main match ends in a tie.
     * Super Over = 1 over (6 balls) per side. The team that batted second
     * in the main match bats first in the Super Over (standard cricket rule).
     */
    private startSuperOver() {
        this.isSuperOver      = true;
        this.superOverInnings = 0;

        // Preserve original roles for reference
        this.originalBattingSid = this.battingSid;
        this.originalBowlingSid = this.bowlingSid;

        // In Super Over, the team that batted second in the main match bats first
        // (this.bowlingSid was batting in innings 2, this.battingSid was bowling in innings 2)
        // So for super over: innings2 batter goes first → that's this.bowlingSid
        this.battingSid = this.originalBowlingSid;
        this.bowlingSid = this.originalBattingSid;

        this.state.phase = "super_over";
        this.trace("startSuperOver", "SEND", "super_over_start", { reason: "tied", innings1Score: this.state.innings1.score, innings2Score: this.state.innings2.score });
        this.broadcast("super_over_start", {
            reason: "tied",
            innings1Score: this.state.innings1.score,
            innings2Score: this.state.innings2.score,
        });

        // Start first super over innings after a short delay
        this.clock.setTimeout(() => this.startSuperOverInnings(1), this.t(3000));
    }

    private startSuperOverInnings(num: number) {
        this.superOverInnings = num;
        const batting = num === 1 ? this.battingSid : this.bowlingSid;
        const bowling = num === 1 ? this.bowlingSid : this.battingSid;

        const innings = num === 1 ? this.state.superOverInnings1 : this.state.superOverInnings2;
        innings.battingPlayerId = this.state.players.get(batting)!.playerId;
        innings.bowlingPlayerId = this.state.players.get(bowling)!.playerId;
        innings.balls           = new ArraySchema<BallState>();
        innings.target          = num === 2 ? this.state.superOverInnings1.score + 1 : -1;

        // Card IDs for super-over live player triple — same pattern as startInnings.
        const soBattingTeam    = this.state.players.get(batting);
        const soBowlingTeam    = this.state.players.get(bowling);
        const soStrikerCardId  = soBattingTeam?.battingPlayers?.[0]?.playerId || "";
        const soNonStrikerCardId = soBattingTeam?.battingPlayers?.[1]?.playerId || "";
        const soBowlerCardId   = soBowlingTeam?.bowlingPlayers?.[0]?.playerId || "";
        this.trace("startSuperOverInnings", "SEND", "innings_start", { inningsNumber: num, isSuperOver: true, battingPlayerId: innings.battingPlayerId, bowlingPlayerId: innings.bowlingPlayerId, target: innings.target, oversPerInnings: 1, strikerCardId: soStrikerCardId, nonStrikerCardId: soNonStrikerCardId, bowlerCardId: soBowlerCardId });
        this.broadcast("innings_start", {
            inningsNumber: num, isSuperOver: true,
            battingPlayerId: innings.battingPlayerId, bowlingPlayerId: innings.bowlingPlayerId,
            target: innings.target, oversPerInnings: 1,
            strikerCardId: soStrikerCardId, nonStrikerCardId: soNonStrikerCardId, bowlerCardId: soBowlerCardId,
        });
        this.clock.setTimeout(() => this.promptBothPowerSelection(batting, bowling), this.t(1500));
    }

    private endSuperOverInnings() {
        const innings = this.activeSuperOverInnings();
        innings.isComplete = true;
        this.trace("endSuperOverInnings", "SEND", "innings_end", { inningsNumber: this.superOverInnings, isSuperOver: true, score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled });
        this.broadcast("innings_end", {
            inningsNumber: this.superOverInnings, isSuperOver: true,
            score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled,
        });

        if (this.superOverInnings === 1) {
            // Break before super over innings 2
            this.trace("endSuperOverInnings", "SEND", "innings_break", { innings1Score: innings.score, innings1Wickets: innings.wickets, innings1Balls: innings.ballsBowled, target: innings.score + 1, breakDuration: 3 });
            this.broadcast("innings_break", {
                innings1Score: innings.score, innings1Wickets: innings.wickets,
                innings1Balls: innings.ballsBowled, target: innings.score + 1, breakDuration: 3,
            });
            this.clock.setTimeout(() => this.startSuperOverInnings(2), this.t(3000));
        } else {
            this.resolveSuperOver();
        }
    }

    private resolveSuperOver() {
        const s1 = this.state.superOverInnings1.score;
        const s2 = this.state.superOverInnings2.score;

        if (s1 === s2) {
            // Still tied after super over — use boundary count or wickets as tiebreaker
            // Fewer wickets lost wins; if still equal, it's a draw
            const w1 = this.state.superOverInnings1.wickets;
            const w2 = this.state.superOverInnings2.wickets;
            if (w1 !== w2) {
                // Fewer wickets = winner (batting team in that SO innings)
                const soWinBatSid = w1 < w2 ? this.battingSid : this.bowlingSid;
                const soLoseSid   = w1 < w2 ? this.bowlingSid : this.battingSid;
                this.endMatch(soWinBatSid, soLoseSid, "super_over_wickets");
            } else {
                // Absolute tie — declare draw
                this.endMatch("", "", "draw");
            }
            return;
        }

        // Super over innings 1 batter = this.battingSid, innings 2 batter = this.bowlingSid
        const soWinSid  = s1 > s2 ? this.battingSid : this.bowlingSid;
        const soLoseSid = s1 > s2 ? this.bowlingSid : this.battingSid;
        this.endMatch(soWinSid, soLoseSid, "super_over");
    }

    private activeSuperOverInnings(): InningsData {
        return this.superOverInnings === 1 ? this.state.superOverInnings1 : this.state.superOverInnings2;
    }

    // ── Ball Loop ───────────────────────────────────────────────────────────

    // ── Parallel Power Selection (replaces sequential promptBowler/Batsman) ─
    //
    // Fires both select_bowler_card AND select_batsman_card simultaneously.
    // Each message now carries:
    //   - activeCardId           : playerId of the card in-play this ball
    //   - availablePowers[]      : triggered powers the player can activate
    //   - availableCards[]       : only populated when requiresCardSelection=true
    //   - requiresCardSelection  : true only when bowler needs to pick a new
    //                              bowler at the start of a new over
    //   - usesRemaining          : map of powerId → remaining activations
    //
    // Client replies with select_bowler / select_batsman carrying:
    //   - cardId                 : chosen card (equals activeCardId when auto)
    //   - activatedPowerIds[]    : powers being activated for THIS ball (bundled)
    //
    // Once BOTH sides reply, server fires promptBowlerPattern with the combined
    // power flags applied to the pattern preview.
    private promptBothPowerSelection(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        this.state.awaitingBowlerSelection = true;
        this.state.awaitingBatsmanTap      = false;
        this.bowlerPlayerId  = "";
        this.batsmanPlayerId = "";
        this.cardSelectsPending = { bowler: true, batsman: true };
        this.pendingBundledPowers = { bowler: [], batsman: [] };

        // ── Determine the active cards for this ball ──

        // Batsman: auto-select striker (current rotation — simple: first active batsman).
        // Striker rotation is a future enhancement; for now use first non-null batsman card.
        const batter  = this.state.players.get(battingSid);
        const striker = batter?.battingPlayers?.[0];
        const batsmanActiveCardId = striker?.playerId || "";

        // Bowler: at start of a new over (ballInOver === 0), prompt to pick a bowler
        //         (unless only one eligible). Otherwise reuse currentOverBowlerId.
        const bowler    = this.state.players.get(bowlingSid);
        const allBowlers: TeamPlayer[] = bowler?.bowlingPlayers ? Array.from(bowler.bowlingPlayers) : [];
        const isOverStart = ballInOver === 0;
        let requiresBowlerSelection = false;
        let availableBowlerIds: string[] = [];
        let bowlerActiveCardId = "";

        if (isOverStart) {
            // Dynamic per-bowler over cap = ceil(totalOvers / bowlerCount). Produces
            // an even distribution for any match length (3 overs/2 bowlers → cap 2,
            // 5/2 → cap 3, super-over → cap 1).
            const totalOvers   = this.isSuperOver ? 1 : this.state.oversPerMatch;
            const bowlerCount  = allBowlers.length || 1;
            const perBowlerCap = Math.max(1, Math.ceil(totalOvers / bowlerCount));
            availableBowlerIds = allBowlers
                .filter((c: TeamPlayer) => (this.bowlerOversBowled.get(c.playerId) || 0) < perBowlerCap)
                .map((c: TeamPlayer) => c.playerId);
            // Exclude previous over's bowler (no consecutive overs), as long as an
            // alternative remains eligible. Forces rotation so a 1F+1S lineup alternates.
            if (this.currentOverBowlerId && availableBowlerIds.length > 1) {
                const alternatives = availableBowlerIds.filter(id => id !== this.currentOverBowlerId);
                if (alternatives.length >= 1) availableBowlerIds = alternatives;
            }
            if (availableBowlerIds.length > 1) {
                requiresBowlerSelection = true;
                bowlerActiveCardId = availableBowlerIds[0]; // default; UI may change
            } else {
                bowlerActiveCardId = availableBowlerIds[0] || allBowlers[0]?.playerId || "";
                this.currentOverBowlerId = bowlerActiveCardId;
            }
            console.log(`[OverStart] over=${over} pool=${allBowlers.length} cap=${perBowlerCap} avail=${availableBowlerIds.length} requiresSel=${requiresBowlerSelection} active=${bowlerActiveCardId}`);
        } else {
            bowlerActiveCardId = this.currentOverBowlerId || allBowlers[0]?.playerId || "";
        }

        // ── Build power manifests for each side ──

        const bowlerCard = allBowlers.find((c: TeamPlayer) => c.playerId === bowlerActiveCardId);
        const batsmanCard = batter?.battingPlayers?.find((c: TeamPlayer) => c.playerId === batsmanActiveCardId);

        const bowlerPowers  = this.buildPowerManifest(bowlingSid, bowlerCard);
        const batsmanPowers = this.buildPowerManifest(battingSid, batsmanCard);

        // ── Send both prompts in parallel ──
        const bowlerClient  = this.clients.find(c => c.sessionId === bowlingSid);
        const batsmanClient = this.clients.find(c => c.sessionId === battingSid);

        this.trace("promptBothPowerSelection", "SEND", "select_bowler_card", {
            recipient: bowlingSid, ballNumber, over, ballInOver,
            activeCardId: bowlerActiveCardId,
            requiresCardSelection: requiresBowlerSelection,
            availableCards: availableBowlerIds.length,
            powers: bowlerPowers.map(p => p.powerId).join(","),
            timeoutSeconds: CARD_SELECT_TIMEOUT / 1000,
        });
        bowlerClient?.send("select_bowler_card", {
            role: "bowler",
            ballNumber, over, ballInOver,
            activeCardId: bowlerActiveCardId,
            requiresCardSelection: requiresBowlerSelection,
            availableCardIds: availableBowlerIds,
            availablePowers: bowlerPowers,
            timeoutSeconds: CARD_SELECT_TIMEOUT / 1000,
        });

        this.trace("promptBothPowerSelection", "SEND", "select_batsman_card", {
            recipient: battingSid, ballNumber, over, ballInOver,
            activeCardId: batsmanActiveCardId,
            requiresCardSelection: false,
            powers: batsmanPowers.map(p => p.powerId).join(","),
            timeoutSeconds: CARD_SELECT_TIMEOUT / 1000,
        });
        batsmanClient?.send("select_batsman_card", {
            role: "batsman",
            ballNumber, over, ballInOver,
            activeCardId: batsmanActiveCardId,
            requiresCardSelection: false,
            availableCardIds: [],
            availablePowers: batsmanPowers,
            timeoutSeconds: CARD_SELECT_TIMEOUT / 1000,
        });

        // ── Single timer: on expiry, auto-fill any missing side with empty powers ──
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.cardSelectsPending.bowler) {
                this.bowlerPlayerId = bowlerActiveCardId;
                this.cardSelectsPending.bowler = false;
            }
            if (this.cardSelectsPending.batsman) {
                this.batsmanPlayerId = batsmanActiveCardId;
                this.cardSelectsPending.batsman = false;
            }
            this.advanceAfterBothCardSelects(battingSid, bowlingSid);
        }, this.t(CARD_SELECT_TIMEOUT));

        // ── Bot auto-responds for its role ──
        if (this.isBot && bowlingSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (!this.cardSelectsPending.bowler) return;
                const botPowers = this.pickBotPowers(bowlerPowers);
                this.applyBundledActivations(bowlingSid, bowlerActiveCardId, botPowers);
                this.bowlerPlayerId = bowlerActiveCardId;
                this.pendingBundledPowers.bowler = botPowers;
                this.cardSelectsPending.bowler = false;
                if (!this.cardSelectsPending.batsman) {
                    this.ballTimer?.clear();
                    this.advanceAfterBothCardSelects(battingSid, bowlingSid);
                }
            }, BOT_RESPONSE_DELAY);
        }
        if (this.isBot && battingSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (!this.cardSelectsPending.batsman) return;
                const botPowers = this.pickBotPowers(batsmanPowers);
                this.applyBundledActivations(battingSid, batsmanActiveCardId, botPowers);
                this.batsmanPlayerId = batsmanActiveCardId;
                this.pendingBundledPowers.batsman = botPowers;
                this.cardSelectsPending.batsman = false;
                if (!this.cardSelectsPending.bowler) {
                    this.ballTimer?.clear();
                    this.advanceAfterBothCardSelects(battingSid, bowlingSid);
                }
            }, BOT_RESPONSE_DELAY);
        }
    }

    /**
     * Builds the list of triggered powers available for the given card this ball,
     * including uses-remaining.
     */
    private buildPowerManifest(sid: string, card: TeamPlayer | undefined): Array<{ powerId: string; cardId: string; usesRemaining: number; maxUses: number; }> {
        if (!card) return [];
        const manifest: Array<{ powerId: string; cardId: string; usesRemaining: number; maxUses: number; }> = [];
        const powerType = card.powerType;
        if (!powerType) return manifest;
        const effect = getPowerEffect(powerType);
        // Only triggered powers are surfaced — passives are always-on, not activatable.
        if (!effect || effect.activation !== "triggered") return manifest;
        const usageKey = `${sid}:${powerType}`;
        const used = this.powerUsageCount.get(usageKey) || 0;
        const usesRemaining = effect.maxUsesPerMatch - used;
        if (usesRemaining <= 0) return manifest;
        manifest.push({
            powerId: powerType,
            cardId: card.playerId,
            usesRemaining,
            maxUses: effect.maxUsesPerMatch,
        });
        return manifest;
    }

    /**
     * Bot heuristic: activate each available power with 40% probability.
     */
    private pickBotPowers(manifest: Array<{ powerId: string }>): string[] {
        return manifest
            .filter(() => Math.random() < 0.4)
            .map(p => p.powerId);
    }

    /**
     * Applies power activations bundled inside a select_bowler / select_batsman
     * reply. Emits power_applied broadcast for each one so clients can update UI.
     * Validates each activation (usage cap, already-active, etc.) — silently
     * skips any that fail (no power_rejected spam during select flow).
     */
    /**
     * Merge a client-supplied powerLevels map into the per-room map.
     * Each ball's select_X carries levels for the powers on the active card; we
     * keep the highest level seen per powerId so an explicit upgrade isn't lost
     * if a later message omits it. Levels clamp to 1..4.
     */
    private recordPowerLevels(map: Record<string, number> | undefined): void {
        if (!map) return;
        for (const [pid, raw] of Object.entries(map)) {
            if (typeof raw !== "number") continue;
            const lvl = Math.max(1, Math.min(4, raw | 0));
            const cur = this.powerLevels.get(pid) ?? 0;
            if (lvl > cur) this.powerLevels.set(pid, lvl);
        }
    }

    /**
     * Resolve the level for a specific powerType. Lookup order:
     * 1. Per-card client-reported level (this.powerLevels[powerId]).
     * 2. Firestore default loaded via getPowerEffect (effect.level).
     * 3. Hard fallback: 1.
     * Note: powerLevels is keyed by powerId (e.g. "power_defense") whereas
     * server-side state lookups happen by effectType (e.g. "Defense"). This
     * helper accepts either — when a powerId match misses, it tries an exact
     * match against the effectType key as well.
     */
    private getLevelForEffect(effectType: string, powerId?: string): number {
        if (powerId) {
            const explicit = this.powerLevels.get(powerId);
            if (typeof explicit === "number") return explicit;
        }
        const effectMatch = this.powerLevels.get(effectType);
        if (typeof effectMatch === "number") return effectMatch;
        const eff = getPowerEffect(effectType) as any;
        const seeded = typeof eff?.level === "number" ? eff.level : 1;
        return Math.max(1, Math.min(4, seeded));
    }

    private applyBundledActivations(sid: string, cardId: string, powerIds: string[]) {
        const player = this.state.players.get(sid);
        if (!player) return;
        for (const powerType of powerIds) {
            // ── Direct-handled batsman activations (server enforces gameplay) ──
            // Sledge / BoundaryLegend bypass the generic triggered-activation gate
            // because their behaviour lives in server-tracked counters, not in
            // pattern mutation alone. Client-side pattern stripping (no wicket boxes
            // for Sledge, boundary-only for BL) is gated on the same counters via
            // PowerStateSnapshot.
            if (powerType === "Sledge") {
                const lvl    = this.getLevelForEffect("Sledge");
                const sledgeLvData = getPowerEffect("Sledge").getLevelData(lvl);
                const balls  = typeof sledgeLvData.freeHitBalls === "number"
                    ? sledgeLvData.freeHitBalls          // Firestore-driven
                    : Math.max(1, lvl);                  // Legacy formula L1=1..L4=4
                this.sledgeBallsRemaining = Math.max(this.sledgeBallsRemaining, balls);
                console.log(`####_PWR_SRV_ACTIVATE_SLEDGE sid=${sid} cardId=${cardId} lvl=${lvl} ballsRemaining=${this.sledgeBallsRemaining}`);
                continue;
            }
            if (powerType === "BoundaryLegend") {
                const lvl    = this.getLevelForEffect("BoundaryLegend");
                const blLvData = getPowerEffect("BoundaryLegend").getLevelData(lvl);
                const N      = typeof blLvData.forcedBoundaryBalls === "number"
                    ? blLvData.forcedBoundaryBalls       // Firestore-driven
                    : 2 + lvl;                           // Legacy formula L1=3..L4=6
                this.boundaryLegendBallsRemaining = N;
                this.boundaryLegendAutoWicketArmed = false;
                console.log(`####_PWR_SRV_ACTIVATE_BL sid=${sid} cardId=${cardId} lvl=${lvl} ballsRemaining=${N}`);
                continue;
            }
            // ── Generic triggered (cooldown/uses-tracked) ──────────────────────
            const effect = getPowerEffect(powerType);
            if (!effect || effect.activation !== "triggered") continue;
            const usageKey = `${sid}:${powerType}`;
            const used = this.powerUsageCount.get(usageKey) || 0;
            if (used >= effect.maxUsesPerMatch) continue;
            if (this.activePowersThisBall.has(powerType + ":" + sid)) continue;

            this.powerUsageCount.set(usageKey, used + 1);
            this.activePowersThisBall.set(powerType + ":" + sid, { sid, cardId });

            const slot = new PowerSlot();
            slot.playerId      = player.playerId;
            slot.powerId       = powerType;
            slot.playerCardId  = cardId;
            slot.active        = true;
            slot.usesRemaining = effect.maxUsesPerMatch - (used + 1);
            this.state.activePowers.push(slot);

            const pu = new PowerUsage();
            pu.powerId        = powerType;
            pu.playerCardId   = cardId;
            pu.playerId       = player.playerId;
            pu.maxUses        = effect.maxUsesPerMatch;
            pu.usesConsumed   = used + 1;
            pu.activeThisBall = true;
            this.state.powerUsages.set(usageKey, pu);

            this.trace("applyBundledActivations", "SEND", "power_applied", {
                playerId: player.playerId, powerId: powerType, cardId, usesRemaining: slot.usesRemaining,
            });
            this.broadcast("power_applied", {
                playerId: player.playerId, powerId: powerType,
                playerCardId: cardId, usesRemaining: slot.usesRemaining,
                effect: effect.label,
            });
        }
    }

    /**
     * Called when both sides have confirmed card + bundled powers.
     * Advances to bowler pattern prompt.
     */
    private advanceAfterBothCardSelects(battingSid: string, bowlingSid: string) {
        if (this.cardSelectsPending.bowler || this.cardSelectsPending.batsman) return;
        this.state.awaitingBowlerSelection = false;

        // Lock in currentOverBowler if this was an over-start pick
        const innings    = this.activeInnings();
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;
        if (ballInOver === 0 && this.bowlerPlayerId) {
            this.currentOverBowlerId = this.bowlerPlayerId;
            const prev = this.bowlerOversBowled.get(this.bowlerPlayerId) || 0;
            this.bowlerOversBowled.set(this.bowlerPlayerId, prev + 1);
        }

        this.promptBowlerPattern(battingSid, bowlingSid);
    }

    private handleSelectBowler(client: Client, msg: { playerId?: string; cardId?: string; activatedPowerIds?: string[]; powerLevels?: Record<string, number> }) {
        if (!this.cardSelectsPending.bowler) return;
        const chosenCard = msg.playerId || msg.cardId || "";
        const powers = Array.isArray(msg.activatedPowerIds) ? msg.activatedPowerIds : [];
        this.bowlerPlayerId = chosenCard;
        this.pendingBundledPowers.bowler = powers;
        this.recordPowerLevels(msg.powerLevels);
        this.applyBundledActivations(client.sessionId, chosenCard, powers);
        this.cardSelectsPending.bowler = false;

        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        if (!this.cardSelectsPending.batsman) {
            this.ballTimer?.clear();
            this.advanceAfterBothCardSelects(bSid, wSid);
        }
    }

    private handleSelectBatsman(client: Client, msg: { playerId?: string; cardId?: string; activatedPowerIds?: string[]; powerLevels?: Record<string, number> }) {
        if (!this.cardSelectsPending.batsman) return;
        const chosenCard = msg.playerId || msg.cardId || "";
        const powers = Array.isArray(msg.activatedPowerIds) ? msg.activatedPowerIds : [];
        this.batsmanPlayerId = chosenCard;
        this.pendingBundledPowers.batsman = powers;
        this.recordPowerLevels(msg.powerLevels);
        this.applyBundledActivations(client.sessionId, chosenCard, powers);
        this.cardSelectsPending.batsman = false;

        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        if (!this.cardSelectsPending.bowler) {
            this.ballTimer?.clear();
            this.advanceAfterBothCardSelects(bSid, wSid);
        }
    }

    // Per-ball pattern data (stored for tap resolution)
    private currentPatternBoxes: PatternBox[] = [];
    // Pattern options cached at promptBowlerPattern time so startBall can use
    // the bowler's chosen option verbatim (no regeneration, no power mutation).
    private pendingPatternA: InitialPattern | null = null;
    private pendingPatternB: InitialPattern | null = null;
    private chosenPattern:   InitialPattern | null = null;

    // ── Bowler Pattern Choice Phase ─────────────────────────────────────────

    /**
     * After both cards are selected, ship a BowlerComputeBundle to the bowler's
     * device. The bowler runs PatternGenerator + PowerSystem locally, picks PA
     * or PB, and replies via `bowler_chosen_pattern`. Server is a pure relay.
     *
     * Batsman gets the legacy `bowler_pattern_prompt` (seed = -1) as a waiting
     * signal — the client treats seed == -1 as "show waiting screen."
     *
     * Fallback paths (bot bowler or real-client timeout) synthesize a plain
     * shuffled pattern server-side via buildInitialPattern — no power mutation.
     */
    private promptBowlerPattern(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        const batter  = this.state.players.get(battingSid);
        const bowling = this.state.players.get(bowlingSid);
        const bowlerCard  = bowling?.bowlingPlayers?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        const batsmanCard = batter?.battingPlayers?.find((c: TeamPlayer) => c.playerId === this.batsmanPlayerId);
        this.currentBowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        // Seed still generated server-side for deterministic bot-fallback. Bowler
        // client ignores it and makes its own seed — DOC: future work (Followups
        // item) lets bowler send its seed back for replay persistence.
        const patternSeedPost   = (Date.now() ^ (ballNumber * 1000 + over * 100)) >>> 0;
        this.patternSeed        = patternSeedPost;
        this.chosenPatternIndex = 0;
        this.pendingPatternA    = null;
        this.pendingPatternB    = null;
        this.chosenPattern      = null;

        this.state.awaitingBowlerPattern = true;

        const bowlerClient  = this.clients.find(c => c.sessionId === bowlingSid);
        const batsmanClient = this.clients.find(c => c.sessionId === battingSid);

        // ── Per-ball context (mirrors startBall) ────────────────────────────
        const previousBallForCtx       = innings.balls.length > 0 ? innings.balls[innings.balls.length - 1] : null;
        const previousBallOutcome      = previousBallForCtx?.outcome || "none";
        const previousBallRuns         = previousBallForCtx?.runs ?? 0;
        const rotateStrikeOccurred     = (previousBallRuns % 2) === 1;
        const isPowerPlayOver          = (over === this.powerPlayOverIndex);

        // Accumulated power state — populated from server-tracked fields.
        const defenseBoundaryWidthMultiplier = bowlerCard
            ? (this.defenseMultiplier.get(bowlerCard.playerId) ?? 1.0)
            : 1.0;
        const srMasterActiveThisBall         = (over === this.srMasterChosenOver) && this.srMasterBallsRemaining > 0;
        const sledgeFreeHitBallsRemaining    = this.sledgeBallsRemaining;
        const boundaryLegendBallsRemaining   = this.boundaryLegendBallsRemaining;
        const extraBallGranted               = this.extraBallGrantedThisOver;
        const centuryMasterGranted           = this.centuryMasterGrantedThisInnings;

        // Power rosters — flatten each card's 3 power slots to a simple ID list.
        const bowlerPowerIds  = this.buildPowerManifest(bowlingSid, bowlerCard ).map(p => p.powerId);
        const batsmanPowerIds = this.buildPowerManifest(battingSid, batsmanCard).map(p => p.powerId);

        // Striker / non-striker for bundle parity with ball_start.
        const battingRoster    = batter?.battingPlayers ? Array.from(batter.battingPlayers) : [];
        const strikerCardId    = this.batsmanPlayerId || battingRoster[0]?.playerId || "";
        const nonStrikerCardId = battingRoster.find((c: TeamPlayer) => c.playerId !== strikerCardId)?.playerId || "";

        // ── Bowler: compute bundle ──────────────────────────────────────────
        const bundleCid = this._mintCid();
        const bundle = {
            cid: bundleCid,
            ballNumber, over, ballInOver,
            bowlerCardId:     this.bowlerPlayerId,
            strikerCardId,
            nonStrikerCardId,
            bowlerType:       this.currentBowlerType,
            bowlerPowerIds,
            batsmanPowerIds,
            ballIndexInOver:  ballInOver,
            isPowerPlayOver,
            previousBallOutcome,
            rotateStrikeOccurred,
            defenseBoundaryWidthMultiplier,
            srMasterActiveThisBall,
            sledgeFreeHitBallsRemaining,
            boundaryLegendBallsRemaining,
            extraBallGranted,
            centuryMasterGranted,
            timeoutSeconds:   PATTERN_SELECT_TIMEOUT / 1000,
        };
        // Stage 2 routing: when bot is bowler, the bot has no client to receive
        // the bundle, so route it to the human BATSMAN client with routedForBot=true.
        // Their `MatchController.OnBowlerComputeBundle` dispatches to `BotBowlerSim`
        // on Bot_View slot 1/3, which runs the full PowerManager pipeline locally
        // and submits the chosen pattern via `bowler_chosen_pattern`. See
        // Match Rule #14 (client) for the full flow.
        // JS type for routedForBot: boolean. Default: false. C# DTO: bool.
        const isBotBowlerRoute = this.isBot && bowlingSid === this.botSid;
        const bowlerBundle = { ...bundle, routedForBot: false };
        this.trace("promptBowlerPattern", "SEND", "bowler_compute_bundle", {
            cid: bundleCid, recipient: "bowler", recipientSid: bowlingSid,
            bowlerType: this.currentBowlerType, bowlPowers: bowlerPowerIds.length,
            batPowers: batsmanPowerIds.length, ballNumber, over,
            routedForBot: false,
        });
        bowlerClient?.send("bowler_compute_bundle", bowlerBundle);
        console.log(`####_BOT_SRV_BUNDLE_BOWLER ball=${ballNumber} over=${over} bowlerSid=${bowlingSid} hasBowlerClient=${bowlerClient != null} isBotBowlerRoute=${isBotBowlerRoute} bowlerType=${this.currentBowlerType}`);

        if (isBotBowlerRoute) {
            const botBundleCid = this._mintCid();
            const botRoutedBundle = { ...bundle, cid: botBundleCid, routedForBot: true };
            this.trace("promptBowlerPattern", "SEND", "bowler_compute_bundle", {
                cid: botBundleCid, recipient: "human_batsman_for_bot", recipientSid: battingSid,
                bowlerType: this.currentBowlerType, bowlPowers: bowlerPowerIds.length,
                batPowers: batsmanPowerIds.length, ballNumber, over,
                routedForBot: true,
            });
            batsmanClient?.send("bowler_compute_bundle", botRoutedBundle);
            console.log(`####_BOT_SRV_BUNDLE_ROUTE_TO_HUMAN ball=${ballNumber} over=${over} batsmanSid=${battingSid} hasBatsmanClient=${batsmanClient != null} routedForBot=true bowlerType=${this.currentBowlerType} — human's BotBowlerSim will compute + submit.`);
            if (!batsmanClient) {
                console.error(`####_BOT_SRV_BUNDLE_ERR ball=${ballNumber} batsmanClient_null — bot bowler bundle could not route. PATTERN_SELECT_TIMEOUT will fire buildInitialPattern fallback.`);
            }
        }

        // ── Batsman: waiting signal (legacy envelope, seed=-1) ──────────────
        const batsmanCid = this._mintCid();
        this.trace("promptBowlerPattern", "SEND", "bowler_pattern_prompt", {
            cid: batsmanCid, recipient: "batsman", recipientSid: battingSid,
            seed: -1, bowlerType: this.currentBowlerType, ballNumber, over,
        });
        batsmanClient?.send("bowler_pattern_prompt", {
            cid: batsmanCid,
            role: "batsman",
            seed: -1, bowlerType: this.currentBowlerType,
            timeoutSeconds: PATTERN_SELECT_TIMEOUT / 1000,
        });

        // Timeout: build a plain fallback pattern server-side and start the ball.
        this.ballTimer = this.clock.setTimeout(() => {
            if (!this.state.awaitingBowlerPattern) return;
            this.state.awaitingBowlerPattern = false;
            this.chosenPatternIndex = 0;
            this.chosenPattern      = buildInitialPattern(this.patternSeed, this.currentBowlerType);
            console.log(`####_PWR_SRV_FALLBACK label=TIMEOUT ball=${ballNumber} over=${over} shape=${this.chosenPattern.shape} pattern=${fmtPatternBoxes(this.chosenPattern.boxes)}`);
            this.startBall(battingSid, bowlingSid);
        }, this.t(PATTERN_SELECT_TIMEOUT));

        // Bot bowler fallback: no real client to run the compute — synthesize
        // a plain pattern server-side after a short delay.
        if (this.isBot && bowlingSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (!this.state.awaitingBowlerPattern) return;
                this.ballTimer?.clear();
                this.state.awaitingBowlerPattern = false;
                this.chosenPatternIndex = Math.random() < 0.5 ? 0 : 1;
                this.chosenPattern      = buildInitialPattern(this.patternSeed + this.chosenPatternIndex, this.currentBowlerType);
                console.log(`####_PWR_SRV_FALLBACK label=BOT ball=${ballNumber} over=${over} shape=${this.chosenPattern.shape} pattern=${fmtPatternBoxes(this.chosenPattern.boxes)}`);
                this.startBall(battingSid, bowlingSid);
            }, BOT_RESPONSE_DELAY);
        }
    }

    /**
     * Legacy index-based choice path — kept as a safety shim. Real bowlers now
     * use handleBowlerChosenPattern. If this ever fires, server builds a plain
     * fallback so the ball can still resolve.
     */
    private handleBowlerPatternChoice(client: Client, msg: { optionIndex: number }) {
        if (!this.state.awaitingBowlerPattern) return;
        this.ballTimer?.clear();
        this.state.awaitingBowlerPattern = false;
        this.chosenPatternIndex = msg.optionIndex === 1 ? 1 : 0;
        this.chosenPattern      = buildInitialPattern(this.patternSeed + this.chosenPatternIndex, this.currentBowlerType);

        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.startBall(bSid, wSid);
    }

    /**
     * Bowler's device has finished its local compute pipeline and is shipping
     * the final cooked pattern (shape + boxes, post power-mutation). Server
     * trusts it verbatim (see Followups.md #1 for re-validation).
     */
    private handleBowlerChosenPattern(client: Client, msg: {
        chosenLabel?: string; patternShape?: string; patternName?: string;
        patternBoxes?: PatternBox[];
    }) {
        if (!this.state.awaitingBowlerPattern) {
            console.log(`####_BOT_SRV_CHOSEN_REJECT_NOT_AWAITING senderSid=${client.sessionId} reason=!awaitingBowlerPattern (already resolved or fallback fired)`);
            return;
        }
        // Sender check:
        //   1. Real bowler client (PvP human bowler).
        //   2. Stage 2 bot routing: when bot is bowler, the human BATSMAN client
        //      hosts the BotBowlerSim and forwards the bot's chosen pattern.
        const senderIsBowler        = client.sessionId === this.bowlingSid;
        const senderIsBotBowlerRoute = this.isBot
            && this.bowlingSid === this.botSid
            && client.sessionId === this.battingSid;
        if (!senderIsBowler && !senderIsBotBowlerRoute) {
            console.log(`####_BOT_SRV_CHOSEN_REJECT_BAD_SENDER senderSid=${client.sessionId} bowlingSid=${this.bowlingSid} battingSid=${this.battingSid} isBot=${this.isBot} — pattern rejected.`);
            return;
        }
        console.log(`####_BOT_SRV_CHOSEN_ACCEPT senderSid=${client.sessionId} senderIsBowler=${senderIsBowler} senderIsBotBowlerRoute=${senderIsBotBowlerRoute} isBot=${this.isBot} botSid=${this.botSid} bowlingSid=${this.bowlingSid} label=${msg.chosenLabel} shape=${msg.patternShape}`);

        this.ballTimer?.clear();
        this.state.awaitingBowlerPattern = false;

        const shape: "StraightLine" | "Ring" = msg.patternShape === "Ring" ? "Ring" : "StraightLine";
        const boxes: PatternBox[] = Array.isArray(msg.patternBoxes) ? msg.patternBoxes : [];
        this.chosenPatternIndex = msg.chosenLabel === "PB" ? 1 : 0;
        this.chosenPattern      = { shape, boxes };

        this.trace("handleBowlerChosenPattern", "RECV", "bowler_chosen_pattern", {
            sid: client.sessionId, label: msg.chosenLabel, shape, boxes: boxes.length,
        });
        console.log(`####_PWR_SRV_CHOSEN_FROM_BOWLER label=${msg.chosenLabel} shape=${shape} pattern=${fmtPatternBoxes(boxes)}`);

        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.startBall(bSid, wSid);
    }

    // ── Ball Start & Resolution ─────────────────────────────────────────────

    private startBall(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        const bowlerCard  = this.state.players.get(bowlingSid)?.bowlingPlayers?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        const batsmanCard = this.state.players.get(battingSid)?.battingPlayers?.find((c: TeamPlayer) => c.playerId === this.batsmanPlayerId);
        const bowlerType  = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        // ── Arrow speed: use the base value set at card selection. ──
        // All speed modifications (EagleEye, SuperFastBall, etc.) are applied
        // client-side by PowerSystem before the slider renders.
        const arrowSpeed = this.state.currentBallArrowSpeed;
        this.currentBallBroadcastArrowSpeed = arrowSpeed;

        const effectiveTimeout = BALL_TIMEOUT_MS;

        // ── Use bowler's chosen pattern verbatim. No regeneration, no server-side
        //    power mutation. Client's PowerSystem applies all powers before render. ──
        const effectiveSeed = this.patternSeed + this.chosenPatternIndex;
        if (this.chosenPattern == null) {
            console.error(`####_FALLBACK_PATTERN_BUILDINIT ball=${ballNumber} over=${over} reason='chosenPattern_null_at_startBall' — bowler-client compute path didn't deliver a chosen pattern; using server-side plain pattern (no powers).`);
        }
        const pattern: InitialPattern = this.chosenPattern ?? buildInitialPattern(effectiveSeed, bowlerType);
        this.currentPatternBoxes = pattern.boxes;

        const chosenLabel = this.chosenPatternIndex === 1 ? "PB" : "PA";
        console.log(`####_PWR_SRV_CHOSEN label=${chosenLabel} ball=${ballNumber} over=${over} shape=${pattern.shape} seed=${effectiveSeed} pattern=${fmtPatternBoxes(pattern.boxes)}`);

        // Active powers list is empty on the wire — client derives from its own
        // PowerSystem state. Field kept for DTO compatibility.
        const activePowers: { powerId: string; cardId: string; effectValue: number }[] = [];

        this.state.awaitingBatsmanTap = true;
        const ballStartCid = this._mintCid();
        // Striker / non-striker card IDs for the live-player HUD. Server currently
        // picks batsmanPlayerId = battingPlayers[0], so non-striker is battingPlayers[1]
        // (fallback to any other batsman when rotation lands the striker at [1]).
        const ballStartBattingTeam = this.state.players.get(battingSid);
        const battingRoster        = ballStartBattingTeam?.battingPlayers ? Array.from(ballStartBattingTeam.battingPlayers) : [];
        const strikerCardId        = this.batsmanPlayerId || battingRoster[0]?.playerId || "";
        const nonStrikerCardId     = battingRoster.find((c: TeamPlayer) => c.playerId !== strikerCardId)?.playerId || "";
        // ── Per-ball context + accumulated power state (PowerImplementationLogic.md) ──
        // Flat fields — client DTO assembles BallContext + PowerStateSnapshot via helpers.
        // Accumulated state fields are stubbed to safe defaults until full server-side
        // tracking lands (Defense wicket count, SR Master over selection, Sledge/BL ball
        // counters, ExtraBall/CenturyMaster grant flags).
        const previousBallForCtx       = innings.balls.length > 0 ? innings.balls[innings.balls.length - 1] : null;
        const previousBallOutcome      = previousBallForCtx?.outcome || "none";
        const previousBallRuns         = previousBallForCtx?.runs ?? 0;
        const rotateStrikeOccurred     = (previousBallRuns % 2) === 1;
        const ballIndexInOver          = ballInOver;
        const isPowerPlayOver          = (over === this.powerPlayOverIndex);

        const defenseBoundaryWidthMultiplier = bowlerCard
            ? (this.defenseMultiplier.get(bowlerCard.playerId) ?? 1.0)
            : 1.0;
        const srMasterActiveThisBall         = (over === this.srMasterChosenOver) && this.srMasterBallsRemaining > 0;
        const sledgeFreeHitBallsRemaining    = this.sledgeBallsRemaining;
        const boundaryLegendBallsRemaining   = this.boundaryLegendBallsRemaining;
        const extraBallGranted               = this.extraBallGrantedThisOver;
        const centuryMasterGranted           = this.centuryMasterGrantedThisInnings;

        this.trace("startBall", "SEND", "ball_start", { cid: ballStartCid, ballNumber, over, ballInOver, arrowSpeed, bowlerType, patternSeed: effectiveSeed, patternShape: pattern.shape, boxCount: pattern.boxes?.length, strikerCardId, nonStrikerCardId, bowlerCardId: this.bowlerPlayerId, previousBallOutcome, rotateStrikeOccurred });
        this.broadcast("ball_start", {
            cid: ballStartCid,
            ballNumber, over, ballInOver, arrowSpeed,
            timeoutSeconds: effectiveTimeout / 1000,
            bowlerPlayerId: this.bowlerPlayerId, bowlerType,
            // Live-player HUD card IDs (striker / non-striker / bowler)
            strikerCardId, nonStrikerCardId, bowlerCardId: this.bowlerPlayerId,
            // Pattern fields — server ships the bowler's chosen pattern verbatim.
            patternSeed: effectiveSeed,
            patternShape: pattern.shape,
            patternBoxes: pattern.boxes,
            // Debug: ship both options + which was chosen so client can dry-run powers on both
            // and log dual PA/PB lifecycle. Gameplay still uses patternBoxes (the chosen one).
            patternOptionABoxes: this.pendingPatternA?.boxes ?? [],
            patternOptionBBoxes: this.pendingPatternB?.boxes ?? [],
            chosenPatternLabel: this.chosenPatternIndex === 1 ? "PB" : "PA",
            serverStartTime: Date.now() / 1000,
            activePowers,
            // Per-ball context (PowerImplementationLogic.md)
            ballIndexInOver,
            isPowerPlayOver,
            previousBallOutcome,
            rotateStrikeOccurred,
            // Accumulated power state (PowerImplementationLogic.md)
            defenseBoundaryWidthMultiplier,
            srMasterActiveThisBall,
            sledgeFreeHitBallsRemaining,
            boundaryLegendBallsRemaining,
            extraBallGranted,
            centuryMasterGranted,
        });
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.state.awaitingBatsmanTap) this.resolveBall(0.0, battingSid, bowlingSid);
        }, this.t(effectiveTimeout));

        // Stage 2: bot batsman tap moved to client-side BotBatsmanSim on
        // Bot_View slot 2/4. The human bowler client now hosts the bot's batting
        // sim and submits via `batsman_tap` → handleBatsmanTap. If the human
        // client crashes or never submits, the BALL_TIMEOUT_MS timer above
        // (line ~1734) fires resolveBall(0.0, ...) as a defensive fallback.
        // Removed: previous server-side per-ball tap simulation via
        // scheduleBotAction. See Match Rule #14.
    }

    private handleBatsmanTap(client: Client, msg: { position: number, hitValue?: number }) {
        if (!this.state.awaitingBatsmanTap) {
            console.log(`####_BOT_SRV_TAP_REJECT_NOT_AWAITING senderSid=${client.sessionId} pos=${msg.position} reason=!awaitingBatsmanTap`);
            return;
        }
        const isBotBatsmanRoute = this.isBot && this.battingSid === this.botSid && client.sessionId === this.bowlingSid;
        const senderIsBatsman   = client.sessionId === this.battingSid;
        console.log(`####_BOT_SRV_TAP_ACCEPT senderSid=${client.sessionId} pos=${msg.position.toFixed(4)} hitValue=${msg.hitValue ?? 'null'} senderIsBatsman=${senderIsBatsman} isBotBatsmanRoute=${isBotBatsmanRoute} isBot=${this.isBot} botSid=${this.botSid} battingSid=${this.battingSid}`);
        this.ballTimer?.clear();
        this.state.awaitingBatsmanTap = false;
        this.lastBatsmanTapPosition = msg.position;
        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.resolveBall(msg.position, bSid, wSid, msg.hitValue);
    }

    /**
     * Resolves a tap position (0..1) against the current pattern boxes.
     * Each box occupies a proportional width zone. Returns the box value hit.
     */
    private resolveAgainstPattern(position: number): number {
        const boxes = this.currentPatternBoxes;
        if (boxes.length === 0) return 0; // dot if no pattern

        const totalWidth = boxes.reduce((sum, b) => sum + b.width, 0);
        let cumulative = 0;
        for (const box of boxes) {
            cumulative += box.width / totalWidth;
            if (position < cumulative) return box.value;
        }
        return boxes[boxes.length - 1].value;
    }

    // ── Ball Resolution ──────────────────────────────────────────────────────

    private resolveBall(position: number, battingSid: string, bowlingSid: string, clientHitValue?: number) {
        // Stop any in-flight bot slider echo BEFORE computing/broadcasting the
        // outcome so stale echoes never arrive after ball_result on the viewer.
        this.clearBotEchoTimer();
        const innings = this.activeInnings();

        // Resolve tap against the pattern boxes broadcast at ball_start.
        // The client may report the visually-detected hit box value (clientHitValue);
        // trust it when it matches a value present in the current pattern (not the
        // -999 sentinel). Otherwise resolve by slider position against the pattern.
        let value: number;
        const clientProvided = typeof clientHitValue === "number" && clientHitValue !== -999;
        const clientValidInPattern =
            clientProvided &&
            this.currentPatternBoxes.length > 0 &&
            this.currentPatternBoxes.some(b => b.value === clientHitValue);

        if (clientValidInPattern) {
            value = clientHitValue as number;
            this.trace("resolveBall", "BRANCH", "client_hit_value", { clientHitValue, position });
        } else if (this.currentPatternBoxes.length > 0) {
            value = this.resolveAgainstPattern(position);
            if (clientProvided) {
                this.trace("resolveBall", "BRANCH", "client_hit_value_rejected", { clientHitValue, fallbackValue: value, position });
            }
        } else {
            // No pattern — defensive fallback, should never happen once Firestore
            // pattern_boxes_json is populated. Treat as dot so match can progress.
            console.warn("[resolveBall] No pattern boxes present — treating as dot.");
            value = 0;
        }

        let outcome = "dot", runs = 0, originalRuns = 0;
        const powersApplied: string[] = [];

        // ── BoundaryLegend auto-wicket: previous ball span ended → force wicket ──
        if (this.boundaryLegendAutoWicketArmed) {
            value = -1;
            this.boundaryLegendAutoWicketArmed = false;
            powersApplied.push("BoundaryLegend:autoWicket");
            console.log(`####_PWR_SRV_BL_AUTOWICKET ball=${innings.ballsBowled + 1} over=${innings.currentOver}`);
        }

        // ── Sledge bypass: free-hit balls — no wicket can fall ──
        if (this.sledgeBallsRemaining > 0 && value === -1) {
            value = 0; // convert wicket to dot
            powersApplied.push("Sledge:wicketBlocked");
            console.log(`####_PWR_SRV_SLEDGE_BLOCK ball=${innings.ballsBowled + 1} ballsRemaining=${this.sledgeBallsRemaining}`);
        }

        if (value === -1) {
            outcome = "wicket";
            innings.wickets++;
        } else if (value > 0) {
            outcome = "run";
            runs = value;
            originalRuns = runs;
            innings.score += runs;
        }

        // ── Catch phase: boundaries trigger catch unless on a Sledge free-hit ──
        const sledgeActive = this.sledgeBallsRemaining > 0;
        if (outcome === "run" && (value === 4 || value === 6) && !sledgeActive && this.shouldTriggerCatch(value, bowlingSid)) {
            this.pendingCatchResult = {
                value, runs, originalRuns, outcome,
                powersApplied: powersApplied.join(","),
                battingSid, bowlingSid,
            };
            this.startCatchPhase(battingSid, bowlingSid);
            return; // Ball not recorded yet — resolveCatch() will finish it
        }

        // ── WicketMaster: bowler deducts runs on every wicket they take ──
        const bowlerCardForPwr = this.state.players.get(bowlingSid)?.bowlingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        if (outcome === "wicket" && bowlerCardForPwr?.powerType === "WicketMaster") {
            const lvl       = this.getLevelForEffect("WicketMaster");
            const wmLvData  = getPowerEffect("WicketMaster").getLevelData(lvl);
            const deduction = typeof wmLvData.runDeductionPerWicket === "number"
                ? wmLvData.runDeductionPerWicket   // Firestore-driven
                : 2 + lvl;                         // Legacy formula L1=3..L4=6
            const before    = innings.score;
            innings.score   = Math.max(0, innings.score - deduction);
            powersApplied.push(`WicketMaster:L${lvl}:-${deduction}`);
            console.log(`####_PWR_SRV_WICKETMASTER lvl=${lvl} deducted=${deduction} score=${before}→${innings.score}`);
        }

        // ── Defense: shrink boundary widths next ball after this wicket ──
        if (outcome === "wicket" && bowlerCardForPwr?.powerType === "Defense") {
            const lvl       = this.getLevelForEffect("Defense");
            const defEffect = getPowerEffect("Defense");
            const defLvData = defEffect.getLevelData(lvl);
            const dec       = typeof defLvData.widthReductionPerWicket === "number"
                ? defLvData.widthReductionPerWicket  // Firestore-driven
                : 0.1 * lvl;                         // Legacy formula L1=−10%..L4=−40%
            const minMult   = defEffect.getPowerWideValue("minimumWidthMultiplier");
            const floor     = typeof minMult === "number" ? minMult : 0.05;
            const cur       = this.defenseMultiplier.get(bowlerCardForPwr.playerId) ?? 1.0;
            const next      = Math.max(floor, cur - dec);
            this.defenseMultiplier.set(bowlerCardForPwr.playerId, next);
            powersApplied.push(`Defense:L${lvl}:${cur.toFixed(2)}→${next.toFixed(2)}`);
            console.log(`####_PWR_SRV_DEFENSE bowler=${bowlerCardForPwr.playerId} lvl=${lvl} mult=${cur.toFixed(2)}→${next.toFixed(2)}`);
        }

        innings.ballsBowled++;
        // Bonus-balls-aware over-completion check. ExtraBall/CenturyMaster grants
        // increment bonusBallsAccumulated; subtracting it from ballsBowled keeps
        // the modulo-6 over boundary aligned with intended overs.
        const effectiveBalls = innings.ballsBowled - this.bonusBallsAccumulated;
        const overJustCompleted = effectiveBalls % this.state.ballsPerOver === 0;
        if (overJustCompleted) {
            innings.currentOver++;
            // Per-over flags reset on actual over end.
            this.extraBallGrantedThisOver = false;
        }

        // ── Decrement per-ball power counters AFTER the ball resolved ──
        if (this.sledgeBallsRemaining > 0) this.sledgeBallsRemaining--;
        if (this.boundaryLegendBallsRemaining > 0) {
            this.boundaryLegendBallsRemaining--;
            if (this.boundaryLegendBallsRemaining === 0) {
                this.boundaryLegendAutoWicketArmed = true; // next ball forces wicket
            }
        }
        if (innings.currentOver === this.srMasterChosenOver && this.srMasterBallsRemaining > 0) {
            this.srMasterBallsRemaining--;
        }

        const ball          = new BallState();
        ball.ballNumber     = innings.ballsBowled;
        ball.outcome        = outcome;
        ball.runs           = runs;
        ball.originalRuns   = originalRuns;
        ball.bowlerPlayerId   = this.bowlerPlayerId;
        ball.batsmanPlayerId  = this.batsmanPlayerId;
        ball.sliderPosition = Math.round(position * 100);
        ball.arrowSpeed     = this.state.currentBallArrowSpeed;
        ball.powerUsed      = powersApplied.join(",");
        innings.balls.push(ball);

        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingPlayers?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        const bowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        const ballResultCid = this._mintCid();
        this.trace("resolveBall", "SEND", "ball_result", { cid: ballResultCid, ballNumber: ball.ballNumber, outcome, runs, originalRuns, score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled, currentOver: innings.currentOver, bowlerType, strikerCardId: this.batsmanPlayerId, bowlerCardId: this.bowlerPlayerId });
        this.broadcast("ball_result", {
            cid: ballResultCid,
            ballNumber: ball.ballNumber, outcome, runs, originalRuns,
            score: innings.score, wickets: innings.wickets,
            ballsBowled: innings.ballsBowled, currentOver: innings.currentOver,
            bowlerType, powerUsed: ball.powerUsed, arrowSpeed: ball.arrowSpeed,
            sliderPosition: ball.sliderPosition,
            // Card IDs — stats credit the striker who faced this ball and the bowler who delivered it
            strikerCardId: this.batsmanPlayerId, bowlerCardId: this.bowlerPlayerId,
        });

        // ── Over completion broadcast ──
        if (overJustCompleted) {
            this.trace("resolveBall", "SEND", "over_end", { overNumber: innings.currentOver, score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled, isSuperOver: this.isSuperOver });
            this.broadcast("over_end", {
                overNumber: innings.currentOver,
                score: innings.score, wickets: innings.wickets,
                ballsBowled: innings.ballsBowled,
                isSuperOver: this.isSuperOver,
            });
        }

        // ── Clear per-ball power state ──
        this.clearBallPowers();

        const overs    = this.isSuperOver ? 1 : this.state.oversPerMatch;
        // Bonus balls (ExtraBall/CenturyMaster) extend the innings by their count.
        const maxBalls = overs * this.state.ballsPerOver + this.bonusBallsAccumulated;
        const maxWkts  = this.isSuperOver ? 1 : this.state.maxWickets;

        // Target chased — end innings (delay broadcast so the last ball's score
        // flash + HUD update is visible before match_end tears down canvases).
        const isChaseInnings = this.isSuperOver ? this.superOverInnings === 2 : this.currentInnings === 2;
        if (isChaseInnings && innings.target > 0 && innings.score >= innings.target) {
            innings.isComplete = true;
            this.clock.setTimeout(() => this.endInnings(), this.t(POST_BALL_INNINGS_END_DELAY));
            return;
        }
        if (innings.ballsBowled >= maxBalls || innings.wickets >= maxWkts) {
            innings.isComplete = true;
            this.clock.setTimeout(() => this.endInnings(), this.t(POST_BALL_INNINGS_END_DELAY));
        } else {
            const nb = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
            const nw = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
            this.clock.setTimeout(() => this.promptBothPowerSelection(nb, nw), this.t(POST_BALL_NEXT_SELECT_DELAY));
        }
    }

    // ── Catch / Fielding Phase ──────────────────────────────────────────────

    /** Determine if a catch mini-game should trigger for this boundary. */
    private shouldTriggerCatch(value: number, bowlingSid: string): boolean {
        const baseChance = value === 4 ? CATCH_CHANCE_4 : CATCH_CHANCE_6;
        // Rarity bonus from bowler card
        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        let rarityBonus = 0;
        switch (bowlerCard?.rarity) {
            case "Rare":      rarityBonus = 0.05; break;
            case "Epic":      rarityBonus = 0.10; break;
            case "Legendary": rarityBonus = 0.15; break;
        }
        return Math.random() < (baseChance + rarityBonus);
    }

    /** Start the catch mini-game after a batsman boundary hit. */
    private startCatchPhase(battingSid: string, bowlingSid: string) {
        this.state.awaitingFielderTap = true;

        const bowlerType = this.currentBowlerType;
        const catchMsg: Record<string, any> = {
            bowlerType,
            timeoutSeconds: CATCH_PHASE_TIMEOUT / 1000,
            // Server timestamp so both clients anchor the rotating arc/box to the same
            // start instant and compute identical angles/positions across the wire.
            serverStartTime: Date.now() / 1000,
        };

        if (bowlerType === "spin") {
            catchMsg.strikeAngle     = this.lastBatsmanTapPosition; // 0-1 normalized
            catchMsg.arcWidthPercent = CATCH_ARC_WIDTH_SPIN;
            catchMsg.rotationSpeed   = CATCH_ROTATION_SPEED;
        } else {
            catchMsg.strikePosition      = this.lastBatsmanTapPosition; // 0-1 normalized
            catchMsg.catchBoxWidthPercent = CATCH_BOX_WIDTH_FAST;
            catchMsg.sweepsPerSecond      = CATCH_SWEEP_SPEED;
        }

        // Bot bowler: pre-roll the catch outcome here so the lone human
        // (the batsman) can drive a realistic local catch animation and freeze
        // it on a position consistent with this result. The client reports
        // back via the existing fielder_tap message; server stays the
        // score-of-record and the trust contract is unchanged.
        const isBotFielder = this.isBot && bowlingSid === this.botSid;
        if (isBotFielder) {
            // Paired sentinel — Colyseus C# DTOs use plain fields (no nullables),
            // so a "has" flag distinguishes absent (PvP, default false) from a
            // genuine `false` outcome (bot rolled drop).
            catchMsg.hasBotPrerolledIsCatch = true;
            catchMsg.botPrerolledIsCatch    = Math.random() < this.botCatchRate;
        }

        // Send to fielder (bowler) as interactive, batsman as read-only
        const bowlerClient  = this.clients.find(c => c.sessionId === bowlingSid);
        const batsmanClient = this.clients.find(c => c.sessionId === battingSid);
        this.trace("startCatchPhase", "SEND", "catch_start", { recipient: "fielder", recipientSid: bowlingSid, bowlerType, isFielderView: true, strikePosition: this.lastBatsmanTapPosition, botPrerolledIsCatch: catchMsg.botPrerolledIsCatch });
        bowlerClient?.send("catch_start",  { ...catchMsg, isFielderView: true });
        this.trace("startCatchPhase", "SEND", "catch_start", { recipient: "batsman", recipientSid: battingSid, bowlerType, isFielderView: false, strikePosition: this.lastBatsmanTapPosition, botPrerolledIsCatch: catchMsg.botPrerolledIsCatch });
        batsmanClient?.send("catch_start", { ...catchMsg, isFielderView: false });

        // Timeout: auto-miss. Covers both PvP and bot — if the batsman's
        // bot-fielder coroutine never reports back within the window, default
        // to a dropped catch.
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.state.awaitingFielderTap) {
                this.resolveCatch(false);
            }
        }, this.t(CATCH_PHASE_TIMEOUT));

        // Bot auto-attempt: removed. The batsman's client now drives a real
        // catch animation locally (see Fastball/SpinballCatchScreen_Manager
        // bot-fielder coroutine) and forwards the pre-rolled outcome via
        // fielder_tap. Server-side slider echo + self-resolve previously
        // produced a stiff linear lerp + delayed coinflip on the player's
        // screen — visually unrealistic.
    }

    private handleFielderTap(client: Client, msg: { isCatch: boolean }) {
        if (!this.state.awaitingFielderTap) {
            console.log(`####_BOT_SRV_FIELDER_REJECT_NOT_AWAITING senderSid=${client.sessionId} isCatch=${msg?.isCatch} reason=!awaitingFielderTap (already resolved or first tap accepted)`);
            return;
        }
        const pending = this.pendingCatchResult;
        if (!pending) {
            console.log(`####_BOT_SRV_FIELDER_REJECT_NO_PENDING senderSid=${client.sessionId} reason=pendingCatchResult_null`);
            return;
        }
        // Validate sender:
        //   PvP — must be the bowling/fielding client.
        //   Bot match (bot is bowler) — bot has no client. The lone human
        //   batsman runs the bot-fielder simulation locally and forwards the
        //   server-pre-rolled outcome; accept their tap as the bot's tap.
        const senderIsFielder = client.sessionId === pending.bowlingSid;
        const isBotFielder    = this.isBot && pending.bowlingSid === this.botSid;
        if (!senderIsFielder && !isBotFielder) {
            console.log(`####_BOT_SRV_FIELDER_REJECT_BAD_SENDER senderSid=${client.sessionId} bowlingSid=${pending.bowlingSid} isBot=${this.isBot} botSid=${this.botSid}`);
            return;
        }
        console.log(`####_BOT_SRV_FIELDER_ACCEPT senderSid=${client.sessionId} isCatch=${msg.isCatch} senderIsFielder=${senderIsFielder} isBotFielder=${isBotFielder}`);
        this.ballTimer?.clear();
        this.resolveCatch(!!msg.isCatch);
    }

    /**
     * Client → Server: batter's ExtraBall / CenturyMaster threshold crossed.
     * Grants exactly one bonus ball — ExtraBall is per-over (resets when over ends),
     * CenturyMaster is per-innings (resets at startInnings). bonusBallsAccumulated
     * extends innings.maxBalls and shifts the modulo math so the over absorbs the
     * extra ball cleanly without touching the existing ballsBowled counter.
     */
    private handleExtraBallRequest(client: Client, msg: { type?: string, playerId?: string }) {
        const type     = msg?.type || "extra_ball";
        const playerId = msg?.playerId || "";
        this.trace("handleExtraBallRequest", "RECV", "extra_ball_request", {
            sid: client.sessionId, type, playerId,
        });

        // Sender must be the active batting client.
        if (client.sessionId !== this.battingSid) {
            client.send("extra_ball_ack", { type, granted: false, reason: "not_batting_client" });
            return;
        }

        if (type === "extra_ball") {
            if (this.extraBallGrantedThisOver) {
                client.send("extra_ball_ack", { type, granted: false, reason: "already_granted_this_over" });
                return;
            }
            this.extraBallGrantedThisOver = true;
            this.bonusBallsAccumulated++;
            console.log(`####_PWR_SRV_EXTRABALL_GRANT playerId=${playerId} bonus=${this.bonusBallsAccumulated}`);
            client.send("extra_ball_ack", { type, granted: true });
            this.broadcast("extra_ball_granted", { type, playerId });
            return;
        }
        if (type === "century_master") {
            if (this.centuryMasterGrantedThisInnings) {
                client.send("extra_ball_ack", { type, granted: false, reason: "already_granted_this_innings" });
                return;
            }
            this.centuryMasterGrantedThisInnings = true;
            this.bonusBallsAccumulated++;
            console.log(`####_PWR_SRV_CENTURYMASTER_GRANT playerId=${playerId} bonus=${this.bonusBallsAccumulated}`);
            client.send("extra_ball_ack", { type, granted: true });
            this.broadcast("extra_ball_granted", { type, playerId });
            return;
        }
        client.send("extra_ball_ack", { type, granted: false, reason: "unknown_type" });
    }

    /** Finalize ball after catch attempt. Reverses runs if caught. */
    private resolveCatch(isCatch: boolean) {
        // Stop bot echo before broadcasting — stale echo must not reach the
        // batsman observer after ball_result.
        this.clearBotEchoTimer();
        this.state.awaitingFielderTap = false;
        const pending = this.pendingCatchResult;
        if (!pending) return;

        const innings = this.activeInnings();
        let { runs, originalRuns, outcome, powersApplied, battingSid, bowlingSid } = pending;

        // Sledge bypass — free hit, no catch can dismiss the batsman.
        const sledgeActive = this.sledgeBallsRemaining > 0;
        if (isCatch && sledgeActive) {
            isCatch = false;
            const apps = powersApplied ? `${powersApplied},Sledge:catchBlocked` : "Sledge:catchBlocked";
            powersApplied = apps;
            console.log(`####_PWR_SRV_SLEDGE_CATCHBLOCK ballsRemaining=${this.sledgeBallsRemaining}`);
        }

        if (isCatch) {
            // Reverse the runs that were tentatively added
            innings.score -= runs;
            innings.wickets++;
            outcome = "catch";
            runs = 0;
        }
        // If dropped, runs remain as they were

        // ── WicketMaster + Defense (catch wicket) ──────────────────────────────
        const bowlerCardForPwrCatch = this.state.players.get(bowlingSid)?.bowlingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        if (isCatch && bowlerCardForPwrCatch?.powerType === "WicketMaster") {
            const lvl       = this.getLevelForEffect("WicketMaster");
            const wmLvData  = getPowerEffect("WicketMaster").getLevelData(lvl);
            const deduction = typeof wmLvData.runDeductionPerWicket === "number"
                ? wmLvData.runDeductionPerWicket
                : 2 + lvl;
            const before    = innings.score;
            innings.score   = Math.max(0, innings.score - deduction);
            const apps = powersApplied ? `${powersApplied},WicketMaster:L${lvl}:-${deduction}` : `WicketMaster:L${lvl}:-${deduction}`;
            powersApplied = apps;
            console.log(`####_PWR_SRV_WICKETMASTER_CATCH lvl=${lvl} deducted=${deduction} score=${before}→${innings.score}`);
        }
        if (isCatch && bowlerCardForPwrCatch?.powerType === "Defense") {
            const lvl  = this.getLevelForEffect("Defense");
            const cur  = this.defenseMultiplier.get(bowlerCardForPwrCatch.playerId) ?? 1.0;
            const dec  = 0.1 * lvl;
            const next = Math.max(0.05, cur - dec);
            this.defenseMultiplier.set(bowlerCardForPwrCatch.playerId, next);
            const apps = powersApplied ? `${powersApplied},Defense:L${lvl}:${cur.toFixed(2)}→${next.toFixed(2)}` : `Defense:L${lvl}:${cur.toFixed(2)}→${next.toFixed(2)}`;
            powersApplied = apps;
            console.log(`####_PWR_SRV_DEFENSE_CATCH bowler=${bowlerCardForPwrCatch.playerId} lvl=${lvl} mult=${cur.toFixed(2)}→${next.toFixed(2)}`);
        }

        // Record ball
        innings.ballsBowled++;
        // Bonus-balls-aware over-completion (mirrors resolveBall).
        const effectiveBallsCatch = innings.ballsBowled - this.bonusBallsAccumulated;
        const overJustCompleted = effectiveBallsCatch % this.state.ballsPerOver === 0;
        if (overJustCompleted) {
            innings.currentOver++;
            this.extraBallGrantedThisOver = false;
        }

        // Decrement per-ball power counters (mirrors resolveBall).
        if (this.sledgeBallsRemaining > 0) this.sledgeBallsRemaining--;
        if (this.boundaryLegendBallsRemaining > 0) {
            this.boundaryLegendBallsRemaining--;
            if (this.boundaryLegendBallsRemaining === 0) {
                this.boundaryLegendAutoWicketArmed = true;
            }
        }
        if (innings.currentOver === this.srMasterChosenOver && this.srMasterBallsRemaining > 0) {
            this.srMasterBallsRemaining--;
        }

        const ball          = new BallState();
        ball.ballNumber     = innings.ballsBowled;
        ball.outcome        = outcome;
        ball.runs           = runs;
        ball.originalRuns   = originalRuns;
        ball.bowlerPlayerId   = this.bowlerPlayerId;
        ball.batsmanPlayerId  = this.batsmanPlayerId;
        ball.sliderPosition = Math.round(this.lastBatsmanTapPosition * 100);
        ball.arrowSpeed     = this.state.currentBallArrowSpeed;
        ball.powerUsed      = powersApplied;
        ball.catchAttempted  = true;
        ball.caughtOut       = isCatch;
        innings.balls.push(ball);

        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        const bowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        // Broadcast catch result
        this.trace("resolveCatch", "SEND", "catch_result", { isCatch, finalOutcome: outcome, runs, originalRuns, score: innings.score, wickets: innings.wickets });
        this.broadcast("catch_result", {
            isCatch, finalOutcome: outcome, runs, originalRuns,
            score: innings.score, wickets: innings.wickets,
        });

        // Also broadcast standard ball_result for backward compat
        const catchBallCid = this._mintCid();
        this.trace("resolveCatch", "SEND", "ball_result", { cid: catchBallCid, ballNumber: ball.ballNumber, outcome, runs, originalRuns, score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled, currentOver: innings.currentOver, bowlerType, catchAttempted: true, caughtOut: isCatch, strikerCardId: this.batsmanPlayerId, bowlerCardId: this.bowlerPlayerId });
        this.broadcast("ball_result", {
            cid: catchBallCid,
            ballNumber: ball.ballNumber, outcome, runs, originalRuns,
            score: innings.score, wickets: innings.wickets,
            ballsBowled: innings.ballsBowled, currentOver: innings.currentOver,
            bowlerType, powerUsed: ball.powerUsed, arrowSpeed: ball.arrowSpeed,
            sliderPosition: ball.sliderPosition,
            catchAttempted: true, caughtOut: isCatch,
            // Card IDs for stats attribution (same as resolveBall)
            strikerCardId: this.batsmanPlayerId, bowlerCardId: this.bowlerPlayerId,
        });

        if (overJustCompleted) {
            this.trace("resolveCatch", "SEND", "over_end", { overNumber: innings.currentOver, score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled, isSuperOver: this.isSuperOver });
            this.broadcast("over_end", {
                overNumber: innings.currentOver,
                score: innings.score, wickets: innings.wickets,
                ballsBowled: innings.ballsBowled,
                isSuperOver: this.isSuperOver,
            });
        }

        this.clearBallPowers();
        this.pendingCatchResult = null;

        // Check end conditions (same as resolveBall)
        const overs    = this.isSuperOver ? 1 : this.state.oversPerMatch;
        const maxBalls = overs * this.state.ballsPerOver + this.bonusBallsAccumulated;
        const maxWkts  = this.isSuperOver ? 1 : this.state.maxWickets;

        const isChaseInnings = this.isSuperOver ? this.superOverInnings === 2 : this.currentInnings === 2;
        if (isChaseInnings && innings.target > 0 && innings.score >= innings.target) {
            innings.isComplete = true;
            this.clock.setTimeout(() => this.endInnings(), this.t(POST_BALL_INNINGS_END_DELAY));
            return;
        }
        if (innings.ballsBowled >= maxBalls || innings.wickets >= maxWkts) {
            innings.isComplete = true;
            this.clock.setTimeout(() => this.endInnings(), this.t(POST_BALL_INNINGS_END_DELAY));
        } else {
            const nb = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
            const nw = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
            this.clock.setTimeout(() => this.promptBothPowerSelection(nb, nw), this.t(POST_BALL_NEXT_SELECT_DELAY));
        }
    }

    // ── Innings / Match End ──────────────────────────────────────────────────

    private endInnings() {
        if (this.isSuperOver) {
            this.endSuperOverInnings();
            return;
        }

        // Guard: a disconnect/forfeit during the POST_BALL_INNINGS_END_DELAY window
        // could fire endMatch first and flip phase to "result". Skip our delayed
        // broadcast in that case to avoid double match_end / stale innings_end.
        if (this.state.phase === "result" || this.state.phase === "innings_break") return;

        const innings = this.activeInnings();
        innings.isComplete = true;
        this.trace("endInnings", "SEND", "innings_end", { inningsNumber: this.currentInnings, isSuperOver: false, score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled });
        this.broadcast("innings_end", {
            inningsNumber: this.currentInnings, isSuperOver: false,
            score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled,
        });

        if (this.currentInnings === 1) {
            this.state.phase = "innings_break";
            this.trace("endInnings", "SEND", "innings_break", { innings1Score: innings.score, innings1Wickets: innings.wickets, innings1Balls: innings.ballsBowled, target: innings.score + 1, breakDuration: 5 });
            this.broadcast("innings_break", {
                innings1Score: innings.score, innings1Wickets: innings.wickets,
                innings1Balls: innings.ballsBowled, target: innings.score + 1, breakDuration: 5,
            });
            this.clock.setTimeout(() => this.startInnings(2), this.t(5000));
        } else {
            this.resolveMatch();
        }
    }

    private resolveMatch() {
        const s1 = this.state.innings1.score;
        const s2 = this.state.innings2.score;
        const w1 = this.state.innings1.wickets;
        const w2 = this.state.innings2.wickets;

        if (s1 === s2) {
            // Scores tied — compare wickets lost first (fewer wickets = winner)
            // innings1 batting = this.battingSid, innings2 batting = this.bowlingSid
            if (w1 !== w2) {
                // Fewer wickets in the respective batting innings = winner
                // w1 = wickets lost by innings1 batter (battingSid), w2 = wickets lost by innings2 batter (bowlingSid)
                if (w1 < w2) {
                    this.endMatch(this.battingSid, this.bowlingSid, "fewer_wickets");
                } else {
                    this.endMatch(this.bowlingSid, this.battingSid, "fewer_wickets");
                }
                return;
            }

            // Scores AND wickets tied — Super Over or draw
            if (this.state.superOverEnabled) {
                this.startSuperOver();
            } else {
                this.endMatch("", "", "draw");
            }
            return;
        }

        // In innings 2 the roles swap: bowlingSid is now batting
        const chaseSid   = this.bowlingSid;
        const defendSid  = this.battingSid;
        if (s2 > s1) this.endMatch(chaseSid,  defendSid, "chase");
        else         this.endMatch(defendSid, chaseSid,  "defended");
    }

    private endMatch(winSid: string, loseSid: string, reason: string) {
        this.clearBotEchoTimer();
        this.state.phase     = "result";
        this.state.winReason = reason;

        const winner = winSid  ? this.state.players.get(winSid)  : null;
        const loser  = loseSid ? this.state.players.get(loseSid) : null;
        this.state.winner = winner?.playerId || "";

        // ── ELO Calculation ──
        const winnerElo = winner?.elo ?? 1000;
        const loserElo  = loser?.elo  ?? 1000;
        const eloDelta  = this.calculateEloDelta(winnerElo, loserElo);
        this.state.eloDelta = eloDelta;

        // ── Match duration ──
        const matchDurationSeconds = Math.round((Date.now() - this.matchStartedAt) / 1000);

        // ── Rewards calculation ──
        const isDraw     = reason === "draw";
        const isAbandon  = reason === "abandoned";   // quitter gets no coins/xp, trophy+ELO penalty only
        const winnerRewards = winner ? {
            xpGained:       isDraw ? REWARD_XP_DRAW    : REWARD_XP_WIN,
            coinsGained:    isDraw ? REWARD_COIN_DRAW   : REWARD_COIN_WIN,
            gemsGained:     0,
            trophiesGained: isDraw ? REWARD_TROPHY_DRAW : REWARD_TROPHY_WIN,
            eloChange:      isDraw ? 0                  : eloDelta,
            cardRewards:    [] as string[],
        } : null;
        const loserRewards = loser ? {
            xpGained:       isDraw ? REWARD_XP_DRAW    : (isAbandon ? 0 : REWARD_XP_LOSS),
            coinsGained:    isDraw ? REWARD_COIN_DRAW   : (isAbandon ? 0 : REWARD_COIN_LOSS),
            gemsGained:     0,
            trophiesGained: isDraw ? REWARD_TROPHY_DRAW : REWARD_TROPHY_LOSS,
            eloChange:      isDraw ? 0                  : -eloDelta,
            cardRewards:    [] as string[],
        } : null;

        // Send personalised match_end to each player
        this.state.players.forEach((player, sid) => {
            const client = this.clients.find(c => c.sessionId === sid);
            if (!client) return;

            const isWinner = sid === winSid;
            // Include "abandoned" in the pass-through set so the client can distinguish.
            const result   = isDraw ? "draw" : (isWinner ? "win" : (reason === "forfeit" || reason === "disconnect" || reason === "abandoned" ? reason : "loss"));
            const rewards  = isWinner ? winnerRewards : loserRewards;
            const opponentPlayerId = isWinner ? (loser?.playerId || "") : (winner?.playerId || "");

            this.trace("endMatch", "SEND", "match_end", { recipient: sid, result, winnerId: winner?.playerId || "", loserId: loser?.playerId || "", reason, eloDelta: rewards?.eloChange ?? 0, s1: this.state.innings1.score, s2: this.state.innings2.score });
            client.send("match_end", {
                matchId:        this.state.matchId,
                result,
                winnerId:       winner?.playerId || "",
                winnerName:     winner?.name     || "",
                loserId:        loser?.playerId  || "",
                loserName:      loser?.name      || "",
                opponentPlayerId,
                reason,
                eloDelta:       rewards?.eloChange ?? 0,
                rewards:        rewards || { xpGained: 0, coinsGained: 0, gemsGained: 0, trophiesGained: 0, eloChange: 0, cardRewards: [] },
                player1FinalScore: this.state.innings1.score,
                player2FinalScore: this.state.innings2.score,
                matchDurationSeconds,
            });
        });

        // Persist faced bot for rotation: append the botProfileId to the human
        // player's `botsFaced` Firestore array. Also reset any band whose
        // profiles are now ALL faced (so the cycle starts fresh next time).
        if (this.isBot && this.botProfileId && this.humanPlayerId && !this.humanPlayerId.startsWith("bot_")) {
            this.persistBotsFaced(this.humanPlayerId, this.botProfileId).catch(err =>
                console.warn(`####_[MatchRoom] persistBotsFaced failed for ${this.humanPlayerId}/${this.botProfileId}: ${err?.message || err}`));
        }

        // Persist match summary to /matches/{matchId} via Admin SDK.
        // Server-authoritative: client writes are blocked by Firestore rules.
        this.persistMatchSummary(
            winner?.playerId || "",
            loser?.playerId || "",
            reason,
            this.state.innings1.score,
            this.state.innings2.score,
            matchDurationSeconds,
        ).catch(err =>
            console.warn(`####_[MatchRoom] persistMatchSummary failed for ${this.state.matchId}: ${err?.message || err}`));

        // Apply reward deltas to each player's Firestore profile via Admin SDK.
        // Server-authoritative — clients can no longer self-mint coins/xp/trophies/mmr.
        if (winner && winnerRewards) {
            this.applyRewardsToProfile(
                winner.playerId,
                winnerRewards.coinsGained, winnerRewards.xpGained,
                winnerRewards.trophiesGained, winnerRewards.eloChange,
            ).catch(err =>
                console.warn(`####_[MatchRoom] applyRewardsToProfile failed for ${winner.playerId}: ${err?.message || err}`));
        }
        if (loser && loserRewards) {
            this.applyRewardsToProfile(
                loser.playerId,
                loserRewards.coinsGained, loserRewards.xpGained,
                loserRewards.trophiesGained, loserRewards.eloChange,
            ).catch(err =>
                console.warn(`####_[MatchRoom] applyRewardsToProfile failed for ${loser.playerId}: ${err?.message || err}`));
        }

        // Keep the room alive long enough for either player to tap Play Again.
        // Extended from 5s → 60s. The handle is tracked so handleRematchRequest
        // can cancel it, and cancelRematch can restart a short (2s) dispose.
        this.matchEndDisposeTimer = this.clock.setTimeout(() => this.disconnect(), 60_000);
    }

    /**
     * Append `botProfileId` to `players/{playerId}.botsFaced`. After the append,
     * checks whether every profile in the band the bot belongs to is now in
     * `botsFaced` — if so, removes those band entries so the rotation starts
     * fresh next time the player matches into that band.
     *
     * Best-effort: failures are logged but don't break the match. Worst case
     * the rotation degrades to "random within band" until the write succeeds.
     */
    private async persistBotsFaced(playerId: string, botProfileId: string): Promise<void> {
        const db = getDb();
        if (!db) return;

        const ref = db.collection("players").doc(playerId);
        const snap = await ref.get();
        const existing: string[] = snap.exists && Array.isArray(snap.data()?.botsFaced)
            ? (snap.data()!.botsFaced as any[]).filter((s: any) => typeof s === "string")
            : [];

        const merged = existing.includes(botProfileId) ? existing : [...existing, botProfileId];

        // Drop any band that's now fully covered — keeps `botsFaced` short and
        // restarts rotation through the band on the next bot match.
        const bandsToReset = getBandsToReset(merged);
        let pruned = merged;
        if (bandsToReset.length > 0) {
            // Re-import getProfileById here would create a circular dep risk; use
            // the loader's getBandsToReset semantics: any id whose band is fully
            // covered should be dropped. Easier: drop ALL ids whose profile sits
            // in a band that's flagged for reset.
            const idsToKeep: string[] = [];
            for (const id of merged) {
                const profile = getProfileById(id);
                if (!profile || !bandsToReset.includes(profile.eloBand)) {
                    idsToKeep.push(id);
                }
            }
            pruned = idsToKeep;
        }

        await ref.set({ botsFaced: pruned }, { merge: true });
        this.trace("persistBotsFaced", "INFO", "written", {
            playerId, added: botProfileId, total: pruned.length, bandsReset: bandsToReset.join(",") || "-",
        });
    }

    /**
     * Atomically apply reward deltas to /players/{playerId} via Admin SDK.
     * Uses FieldValue.Increment to avoid read-modify-write races. Bot ids
     * (prefix "bot_") are skipped — bots have no profile doc.
     * Trophies are clamped to >= 0 post-write if Increment pushed below zero.
     * Best-effort: failures are logged but don't block match teardown.
     */
    private async applyRewardsToProfile(
        playerId: string,
        coinsDelta: number, xpDelta: number, trophiesDelta: number, eloDelta: number,
    ): Promise<void> {
        if (!playerId || playerId.startsWith("bot_")) return;

        const db = getDb();
        if (!db) return;

        const updates: Record<string, any> = {};
        const FieldValue = (await import("firebase-admin/firestore")).FieldValue;
        if (coinsDelta    !== 0) updates["coins"]    = FieldValue.increment(coinsDelta);
        if (xpDelta       !== 0) updates["xp"]       = FieldValue.increment(xpDelta);
        if (trophiesDelta !== 0) updates["trophies"] = FieldValue.increment(trophiesDelta);
        if (eloDelta      !== 0) updates["mmr"]      = FieldValue.increment(eloDelta);

        if (Object.keys(updates).length === 0) return;

        const ref = db.collection("players").doc(playerId);
        await ref.update(updates);

        if (trophiesDelta < 0) {
            const snap = await ref.get();
            const trophies = snap.exists ? (snap.data()?.trophies as number | undefined) : undefined;
            if (typeof trophies === "number" && trophies < 0) {
                await ref.update({ trophies: 0 });
            }
        }

        this.trace("applyRewardsToProfile", "INFO", "written", {
            playerId, coins: coinsDelta, xp: xpDelta, trophies: trophiesDelta, elo: eloDelta,
        });
    }

    /**
     * Write match summary to /matches/{matchId} via Admin SDK.
     * Idempotent — uses matchId as doc key so a duplicate call merges.
     * player1Id / player2Id are required for the read-rule (participants only).
     * Best-effort: failures are logged but don't block match teardown.
     */
    private async persistMatchSummary(
        winnerId: string, loserId: string, reason: string,
        winnerScore: number, loserScore: number, durationSeconds: number,
    ): Promise<void> {
        const db = getDb();
        if (!db) return;

        const matchId = this.state.matchId;
        if (!matchId) return;

        const playerIds: string[] = [];
        this.state.players.forEach(p => { if (p.playerId) playerIds.push(p.playerId); });
        const player1Id = playerIds[0] || "";
        const player2Id = playerIds[1] || "";

        await db.collection("matches").doc(matchId).set({
            matchId,
            player1Id,
            player2Id,
            winnerId,
            loserId,
            reason,
            winnerScore,
            loserScore,
            duration:    durationSeconds,
            completedAt: Date.now(),
        }, { merge: true });

        this.trace("persistMatchSummary", "INFO", "written", {
            matchId, winnerId, loserId, reason, winnerScore, loserScore,
        });
    }

    // ── Rematch ─────────────────────────────────────────────────────────────

    /**
     * Requester-side entry. Valid only once the room has reached `result` and no
     * rematch handshake is already in flight. Cancels the post-match dispose timer,
     * acks the requester, then either auto-accepts (bot opponent) or offers to the
     * human opponent and starts the 20s response timer.
     */
    private handleRematchRequest(client: Client) {
        if (this.state.phase !== "result" || this.rematchPhase !== "") {
            this.trace("handleRematchRequest", "INFO", "invalid_state", { sid: client.sessionId, phase: this.state.phase, rematchPhase: this.rematchPhase });
            client.send("error", { code: "rematch_invalid_state" });
            return;
        }

        const requester = this.state.players.get(client.sessionId);
        if (!requester) return;

        this.rematchPhase       = "pending";
        this.rematchRequestedBy = client.sessionId;
        this.rematchResponses.clear();
        this.rematchResponses.set(client.sessionId, true);

        // Keep the room alive while the handshake runs.
        this.matchEndDisposeTimer?.clear();
        this.matchEndDisposeTimer = null;

        this.trace("handleRematchRequest", "SEND", "rematch_pending_ack", { sid: client.sessionId, requesterId: requester.playerId });
        client.send("rematch_pending_ack", { timeoutSeconds: 20 });

        const oppSid = this.opponentOfSid(client.sessionId);

        // Bot opponent has no real client — auto-accept inline.
        if (this.isBot && oppSid === this.botSid) {
            this.rematchResponses.set(this.botSid, true);
            this.acceptRematch();
            return;
        }

        const oppClient = this.clients.find(c => c.sessionId === oppSid);
        if (oppClient) {
            this.trace("handleRematchRequest", "SEND", "rematch_offered", { targetSid: oppSid, requesterId: requester.playerId });
            oppClient.send("rematch_offered", {
                requesterPlayerId: requester.playerId,
                requesterName:     requester.name,
                timeoutSeconds:    20,
            });
        } else {
            // Opponent client gone — treat as disconnected.
            this.cancelRematch("disconnected", oppSid);
            return;
        }

        this.rematchTimer = this.clock.setTimeout(() => this.cancelRematch("timeout"), 20_000);
    }

    /** Opponent's reply to a pending offer. accept=true counts toward the 2-ready threshold. */
    private handleRematchResponse(client: Client, msg: { accept: boolean }) {
        if (this.rematchPhase !== "pending") return;
        if (!msg || typeof msg.accept !== "boolean") return;

        if (!msg.accept) {
            this.cancelRematch("declined", client.sessionId);
            return;
        }

        this.rematchResponses.set(client.sessionId, true);
        if (this.rematchResponses.size >= 2) {
            this.rematchTimer?.clear();
            this.rematchTimer = null;
            this.acceptRematch();
        }
    }

    /** Both sides accepted — broadcast, reset, re-enter toss. */
    private acceptRematch() {
        this.rematchPhase = "accepted";

        const newMatchId = `${this.roomId}_${Date.now().toString(36)}`;

        this.trace("acceptRematch", "SEND", "rematch_accepted", { newMatchId });
        this.broadcast("rematch_accepted", { newMatchId });

        this.resetRoomForRematch(newMatchId);
        this.startToss();
    }

    /**
     * Zero all match state so the room behaves like a fresh one. Preserves room-level
     * identity (roomId, oversPerMatch, ballsPerOver, superOverEnabled, isPrivate,
     * roomCode, player1Sid, isBot, botSid) and per-player identity (sessionId,
     * playerId, name, elo, teamId, connected).
     */
    private resetRoomForRematch(newMatchId: string) {
        // ── Innings schemas ──
        const resetInnings = (inn: InningsData) => {
            inn.score           = 0;
            inn.wickets         = 0;
            inn.balls           = new ArraySchema<BallState>();
            inn.target          = -1;
            inn.battingPlayerId = "";
            inn.bowlingPlayerId = "";
            inn.ballsBowled     = 0;
            inn.currentOver     = 0;
            inn.isComplete      = false;
        };
        resetInnings(this.state.innings1);
        resetInnings(this.state.innings2);
        resetInnings(this.state.superOverInnings1);
        resetInnings(this.state.superOverInnings2);

        // ── Match-level schema fields ──
        this.state.matchId    = newMatchId;
        this.state.phase      = "lobby";
        this.state.winner     = "";
        this.state.winReason  = "";
        this.state.eloDelta   = 0;
        this.state.tossWinner = "";
        this.state.tossChoice = "";
        this.state.tossCaller = "";
        this.state.awaitingBowlerSelection = false;
        this.state.awaitingBatsmanTap      = false;
        this.state.currentBallArrowSpeed   = 1;

        this.state.activePowers = new ArraySchema<PowerSlot>();
        this.state.powerUsages.clear();

        // ── Per-player: wipe rosters + ready flags, keep identity fields ──
        this.state.players.forEach((p) => {
            p.battingPlayers        = new ArraySchema<TeamPlayer>();
            p.bowlingPlayers        = new ArraySchema<TeamPlayer>();
            p.ready                 = false;
            p.activeBatsmanPlayerId = "";
            p.activeBowlerPlayerId  = "";
            p.isSpeaking            = false;
        });

        // ── Private match-flow fields ──
        this.teamReadyCount      = 0;
        this.selectionReadyCount = 0;
        this.currentInnings      = 0;
        this.isSuperOver         = false;
        this.superOverInnings    = 0;
        this.battingSid          = "";
        this.bowlingSid          = "";
        this.originalBattingSid  = "";
        this.originalBowlingSid  = "";
        this.bowlerPlayerId      = "";
        this.batsmanPlayerId     = "";
        this.patternSeed         = 0;
        this.chosenPatternIndex  = 0;
        this.currentBowlerType   = "fast";
        this.currentOverBowlerId = "";
        this.lastBatsmanTapPosition = 0;
        this.activePowersThisBall.clear();
        this.powerUsageCount.clear();
        this.bowlerOversBowled.clear();
        this.pendingCatchResult = null;
        this.cardSelectsPending = { bowler: false, batsman: false };
        this.pendingBundledPowers = { bowler: [], batsman: [] };
        this.currentPatternBoxes = [];

        // Stop any lingering timers from the previous match.
        this.ballTimer?.clear();       this.ballTimer = null;
        this.tossTimer?.clear();       this.tossTimer = null;
        this.clearBotEchoTimer();

        // ── Rematch bookkeeping ──
        this.rematchPhase       = "";
        this.rematchRequestedBy = "";
        this.rematchResponses.clear();
        this.rematchTimer?.clear();     this.rematchTimer = null;
        this.matchEndDisposeTimer?.clear(); this.matchEndDisposeTimer = null;

        this.trace("resetRoomForRematch", "INFO", "reset_complete", { newMatchId });
    }

    /**
     * Aborts a pending rematch. Valid reasons: "declined", "timeout", "disconnected".
     * Broadcasts rematch_declined, then schedules a short dispose so clients read the
     * message before the room is torn down.
     */
    private cancelRematch(reason: string, byPlayerSid?: string) {
        if (this.rematchPhase !== "pending") return;

        this.rematchTimer?.clear();
        this.rematchTimer = null;

        const byPlayerId = byPlayerSid ? (this.state.players.get(byPlayerSid)?.playerId || "") : "";

        this.rematchPhase       = "declined";
        this.rematchRequestedBy = "";
        this.rematchResponses.clear();

        this.trace("cancelRematch", "SEND", "rematch_declined", { reason, byPlayerId });
        this.broadcast("rematch_declined", { reason, byPlayerId });

        this.matchEndDisposeTimer?.clear();
        this.matchEndDisposeTimer = this.clock.setTimeout(() => this.disconnect(), 2000);
    }

    /** Standard ELO delta calculation using K-factor. */
    private calculateEloDelta(winnerElo: number, loserElo: number): number {
        const expectedWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
        return Math.round(ELO_K_FACTOR * (1 - expectedWin));
    }

    // ── Powers / Forfeit ────────────────────────────────────────────────────

    /**
     * Validates and registers a triggered power activation for the current ball.
     * Passive powers are applied client-side by PowerSystem based on card powerType.
     */
    private handlePowerActivate(client: Client, msg: { powerId: string; cardId?: string; playerCardId?: string }) {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;

        const powerType = msg.powerId;
        const playerCardId = msg.playerCardId || msg.cardId || "";
        const effect = getPowerEffect(powerType);
        if (!effect) {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "unknown_power" });
            client.send("power_rejected", { powerId: powerType, reason: "unknown_power" });
            return;
        }

        // Only triggered powers can be manually activated
        if (effect.activation !== "triggered") {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "passive_power" });
            client.send("power_rejected", { powerId: powerType, reason: "passive_power" });
            return;
        }

        // Must be in an active innings phase
        const phase = this.state.phase;
        if (!phase.startsWith("innings") && phase !== "super_over") {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "wrong_phase", phase });
            client.send("power_rejected", { powerId: powerType, reason: "wrong_phase" });
            return;
        }

        // Q5: powers are locked once both sides have confirmed card selection.
        // Reject any independent power_activate after the pattern prompt phase.
        if (!this.cardSelectsPending.bowler && !this.cardSelectsPending.batsman) {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "powers_locked" });
            client.send("power_rejected", { powerId: powerType, reason: "powers_locked" });
            return;
        }

        // Validate the player owns the card with this powerType
        const allPlayers = [...(player.battingPlayers || []), ...(player.bowlingPlayers || [])];
        const card = allPlayers.find((c: TeamPlayer) => c.playerId === playerCardId && c.powerType === powerType);
        if (!card) {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "player_not_found" });
            client.send("power_rejected", { powerId: powerType, reason: "player_not_found" });
            return;
        }

        // Check usage limit
        const usageKey = `${client.sessionId}:${powerType}`;
        const used = this.powerUsageCount.get(usageKey) || 0;
        if (used >= effect.maxUsesPerMatch) {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "max_uses_reached" });
            client.send("power_rejected", { powerId: powerType, reason: "max_uses_reached" });
            return;
        }

        // Check not already activated this ball
        if (this.activePowersThisBall.has(powerType + ":" + client.sessionId)) {
            this.trace("handlePowerActivate", "SEND", "power_rejected", { recipient: client.sessionId, powerId: powerType, reason: "already_active" });
            client.send("power_rejected", { powerId: powerType, reason: "already_active" });
            return;
        }

        // Register activation
        this.powerUsageCount.set(usageKey, used + 1);
        this.activePowersThisBall.set(powerType + ":" + client.sessionId, {
            sid: client.sessionId, cardId: playerCardId,
        });

        // Update synced state for client UI
        const slot = new PowerSlot();
        slot.playerId      = player.playerId;
        slot.powerId       = powerType;
        slot.playerCardId  = playerCardId;
        slot.active        = true;
        slot.usesRemaining = effect.maxUsesPerMatch - (used + 1);
        this.state.activePowers.push(slot);

        // Update PowerUsage map
        const pu = new PowerUsage();
        pu.powerId       = powerType;
        pu.playerCardId  = playerCardId;
        pu.playerId      = player.playerId;
        pu.maxUses       = effect.maxUsesPerMatch;
        pu.usesConsumed  = used + 1;
        pu.activeThisBall = true;
        this.state.powerUsages.set(usageKey, pu);

        this.trace("handlePowerActivate", "SEND", "power_applied", { playerId: player.playerId, powerId: powerType, playerCardId, usesRemaining: slot.usesRemaining, effect: effect.label });
        this.broadcast("power_applied", {
            playerId: player.playerId, powerId: powerType,
            playerCardId, usesRemaining: slot.usesRemaining,
            effect: effect.label,
        });
    }

    private handleForfeit(client: Client) {
        this.endMatch(this.opponentOf(client.sessionId), client.sessionId, "forfeit");
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** Get opponent session ID using connected clients (human players only). */
    private opponentOf(sid: string): string {
        return this.clients.find(c => c.sessionId !== sid)?.sessionId || "";
    }

    /** Get opponent session ID from state players map (works for bots too). */
    private opponentOfSid(sid: string): string {
        for (const [key] of this.state.players) {
            if (key !== sid) return key;
        }
        return "";
    }

    /** Returns the logical innings number (1 or 2) for the current phase (main or super over). */
    private currentInningsNum(): number {
        return this.isSuperOver ? this.superOverInnings : this.currentInnings;
    }

    private activeInnings(): InningsData {
        if (this.isSuperOver) {
            return this.activeSuperOverInnings();
        }
        return this.currentInnings === 1 ? this.state.innings1 : this.state.innings2;
    }

    // ── Power Helpers ────────────────────────────────────────────────────────

    /** Check if a triggered power is active for the current ball by a specific player. */
    private isPowerActiveThisBall(powerType: string, sid: string): boolean {
        return this.activePowersThisBall.has(powerType + ":" + sid);
    }

    /** Clear per-ball power state, pattern, and reset arrow speed to default. */
    private clearBallPowers() {
        this.activePowersThisBall.clear();
        this.currentPatternBoxes = [];
        this.state.currentBallArrowSpeed = 1; // Reset to default

        // Mark all active power slots as inactive
        for (let i = this.state.activePowers.length - 1; i >= 0; i--) {
            const slot = this.state.activePowers[i];
            if (slot.active) {
                slot.active = false;
            }
        }

        // Reset activeThisBall flags in powerUsages
        this.state.powerUsages.forEach((pu) => {
            if (pu.activeThisBall) pu.activeThisBall = false;
        });
    }

    // ── Bot AI ────────────────────────────────────────────────────────────────

    /**
     * Injects a virtual bot player into the match state.
     * The bot has no real Client; all its actions are scheduled via timers.
     *
     * Bot identity (name, displayName) and roster are sourced from the
     * BotProfile the LobbyRoom picked. options.botName carries the
     * profile-derived "bot_<DisplayName>" string for backward compatibility
     * with the existing player_joined broadcast.
     */
    private injectBot(options: any) {
        this.botSid = BOT_SESSION_ID;
        const profile = this.botProfileId ? getProfileById(this.botProfileId) : null;

        const bot           = new PlayerState();
        bot.sessionId       = this.botSid;
        bot.playerId        = `bot_${this.roomId}`;
        const fallbackName  = options.botName || `Player${Math.floor(Math.random() * 1000)}`;
        const displayName   = profile?.displayName
            || (fallbackName.startsWith("bot_") ? fallbackName.slice(4) : fallbackName);
        bot.name            = `bot_${displayName}`;
        bot.elo             = options.elo     || 1000;
        bot.teamId          = "bot_team";
        bot.connected       = true;
        // Bots have no social photo; client UI falls through to AvatarCatalog sprite-sheet.
        bot.displayName     = displayName;
        bot.avatarUrl       = "";
        this.state.players.set(this.botSid, bot);

        this.trace("injectBot", "SEND", "player_joined", { playerId: bot.playerId, playerName: bot.name, elo: bot.elo, isBot: true, botProfileId: this.botProfileId });
        this.broadcast("player_joined", {
            playerId:     bot.playerId,
            playerName:   bot.name,
            displayName:  bot.displayName,
            avatarUrl:    "",
            elo:          bot.elo,
            botProfileId: this.botProfileId,
        });
        slog("MatchRoom", "bot_injected", { name: bot.name, elo: bot.elo, botProfileId: this.botProfileId });

        // Pre-populate bot's batting/bowling rosters from the chosen profile.
        // No randomized fallback — if profile lookup or catalog resolution
        // fails, botConfirmDeck logs an error and leaves the rosters empty;
        // the match will surface the issue rather than silently render
        // synthetic placeholder cards.
        this.botConfirmDeck();

        // If human is already in, start toss
        if (this.state.players.size >= 2) {
            this.startToss();
        }
    }

    /**
     * Populates the bot's batting + bowling rosters from the chosen BotProfile.
     * Each playerId in the profile is resolved through BotTeamBuilder's catalog
     * reader to produce a full TeamPlayer (name / role / rarity / powerType).
     * No phase gating — called once from injectBot.
     *
     * If the profile is missing or any playerId fails to resolve, the affected
     * slots are simply skipped. Empty rosters are visible end-to-end and will
     * cause downstream startInnings logic to fail loudly — preferred over
     * silently inserting synthetic placeholder players.
     */
    private botConfirmDeck() {
        const bot = this.state.players.get(this.botSid);
        if (!bot || bot.ready) return;

        const profile = this.botProfileId ? getProfileById(this.botProfileId) : null;
        if (!profile) {
            console.error(`####_[MatchRoom] botConfirmDeck: no profile for botProfileId='${this.botProfileId}'. Bot rosters will be empty — match cannot proceed correctly.`);
            this.trace("botConfirmDeck", "ERROR", "no_profile", { botProfileId: this.botProfileId });
            bot.ready = true;
            return;
        }

        const toPlayer = (c: any): TeamPlayer => {
            const p       = new TeamPlayer();
            p.playerId    = c.playerId;
            p.name        = c.name;
            p.role        = c.role;
            p.rarity      = c.rarity;
            p.powerType   = c.powerType;
            p.basePower   = c.basePower;
            p.level       = c.level;
            return p;
        };

        const resolveOrLog = (id: string): TeamPlayer | null => {
            const c = getCatalogPlayer(id);
            if (!c) {
                console.error(`####_[MatchRoom] botConfirmDeck: profile '${profile.botProfileId}' references unknown playerId '${id}' — slot will be empty.`);
                return null;
            }
            return toPlayer(c);
        };

        const battingResolved = profile.battingPlayers.map(resolveOrLog).filter((p): p is TeamPlayer => p !== null);
        const bowlingResolved = profile.bowlingPlayers.map(resolveOrLog).filter((p): p is TeamPlayer => p !== null);

        // Summary of unresolved ids so the admin can fix Firestore in one shot.
        if (battingResolved.length < profile.battingPlayers.length) {
            const missing = profile.battingPlayers.filter(id => !battingResolved.some(p => p.playerId === id));
            console.error(`####_FALLBACK_BOT_PROFILE_PARTIAL profile='${profile.botProfileId}' batting expected=${profile.battingPlayers.length} resolved=${battingResolved.length} missing=[${missing.join(",")}]`);
        }
        if (bowlingResolved.length < profile.bowlingPlayers.length) {
            const missing = profile.bowlingPlayers.filter(id => !bowlingResolved.some(p => p.playerId === id));
            console.error(`####_FALLBACK_BOT_PROFILE_PARTIAL profile='${profile.botProfileId}' bowling expected=${profile.bowlingPlayers.length} resolved=${bowlingResolved.length} missing=[${missing.join(",")}]`);
        }

        bot.teamId          = "bot_team";
        bot.battingPlayers  = new ArraySchema<TeamPlayer>(...battingResolved);
        bot.bowlingPlayers  = new ArraySchema<TeamPlayer>(...bowlingResolved);
        bot.ready           = true;

        this.trace("botConfirmDeck", "INFO", "bot_team_populated", {
            sessionId: this.botSid,
            batting: bot.battingPlayers.length,
            bowling: bot.bowlingPlayers.length,
            botProfileId: profile.botProfileId,
            displayName: profile.displayName,
            playstyle: profile.playstyle,
            source: "profile",
        });
    }

    /**
     * Starts a 20Hz echo that interpolates a normalized slider position
     * (0..1) from 0 → targetPos over durationMs, sent to the lone human
     * opponent. Bot has no client, so only the human receives it. The human's
     * viewer (bowler during bot batting / batsman during bot catch) reads this
     * through OpponentEchoManager and paints the slider directly — same path
     * as human-vs-human P2P echo. Linear drift is cosmetic (not matching the
     * bounce of a real sweep) but sufficient for v1.
     * Replaces any existing echo timer. Cleared on every turn-exit path.
     */
    private startBotSliderEcho(targetPos: number, durationMs: number) {
        this.clearBotEchoTimer();
        if (!this.isBot) return;
        const humanSid = this.opponentOf(this.botSid);
        const humanClient = this.clients.find(c => c.sessionId === humanSid);
        if (!humanClient) return;

        const startedAt = Date.now();
        const stepMs    = 50; // 20 Hz, matches client's P2P echo cadence
        this.botEchoTimer = this.clock.setInterval(() => {
            const elapsed = Date.now() - startedAt;
            const t       = Math.min(1, elapsed / Math.max(1, durationMs));
            const pos     = t * targetPos;
            humanClient.send("bot_slider_echo", { position: pos });
            if (t >= 1) this.clearBotEchoTimer();
        }, stepMs);
    }

    private clearBotEchoTimer() {
        if (this.botEchoTimer) {
            this.botEchoTimer.clear();
            this.botEchoTimer = null;
        }
    }

    /**
     * Called by promptBowlerCard / promptBatsmanCard / startBall when
     * the active player is the bot. Schedules auto-responses.
     */
    private scheduleBotAction() {
        if (!this.isBot) return;

        // If no humans are connected, abandon the match instead of letting the bot
        // play out the remaining balls. Keeps rooms from lingering after app-kill.
        // `clients` only includes real connected clients — the virtual bot is not a client.
        if (this.clients.length === 0 && this.state.phase !== "result") {
            this.endMatch(this.botSid, this.opponentOf(this.botSid), "abandoned");
            return;
        }

        // Bot needs to select bowler card
        if (this.state.awaitingBowlerSelection) {
            const innings = this.activeInnings();
            const bowlerSid = innings.bowlingPlayerId === this.state.players.get(this.botSid)?.playerId
                ? this.botSid : null;
            if (bowlerSid) {
                this.clock.setTimeout(() => {
                    if (!this.state.awaitingBowlerSelection) return;
                    this.ballTimer?.clear();
                    const bot = this.state.players.get(this.botSid);
                    // Per-over rotation: pick a different bowler card each over so
                    // bowler type alternates (was hardcoded [0] for spin-pipeline
                    // testing; user reported back-to-back fast overs from item #6).
                    // Use over index modulo roster length — gives every bowler a
                    // turn in rotation. BotTeamBuilder sorts bowlingPlayers with
                    // Spin first, so over 0 = first card (often Spin), over 1 =
                    // second card, etc.
                    const overIdx = innings.currentOver | 0;
                    const rosterLen = bot?.bowlingPlayers?.length ?? 0;
                    const cardIdx = rosterLen > 0 ? (overIdx % rosterLen) : 0;
                    this.bowlerPlayerId = bot?.bowlingPlayers?.[cardIdx]?.playerId || "bot_bow1";
                    console.log(`####_BOT_SRV_OVER_BOWLER over=${overIdx} cardIdx=${cardIdx}/${rosterLen} bowlerCardId=${this.bowlerPlayerId} — per-over rotation.`);
                    this.state.awaitingBowlerSelection = false;
                    const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
                    const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
                    this.promptBothPowerSelection(bSid, wSid);
                }, BOT_RESPONSE_DELAY);
            }
            return;
        }

        // Stage 2: bot batsman tap branch removed. The human bowler client now
        // hosts BotBatsmanSim on Bot_View slot 2/4 and submits the tap via
        // `batsman_tap` → handleBatsmanTap. The server-side
        // computeWirePosition(...) → resolveBall(...) path is dead code.
        // BALL_TIMEOUT_MS in startBall() is the defensive fallback if the
        // human's bot sim never submits. See Match Rule #14.
    }
}
