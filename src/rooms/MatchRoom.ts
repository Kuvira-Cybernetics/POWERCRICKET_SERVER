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
import { getGameConfig } from "../config/gameConfig.js";
import { log as slog } from "../util/log.js";

// ── Generic log silencer ─────────────────────────────────────────────────────
// Drops any console.log that does NOT start with the tracer prefix "####_".
// console.warn / console.error remain untouched.
// Flip TRACE_SILENCE_GENERIC=false (env var) to restore verbose logging.
(function installTraceFilter() {
    if (process.env.TRACE_SILENCE_GENERIC === "false") return;
    const origLog = console.log;
    const prefix = "####_";
    console.log = (...args: any[]) => {
        const first = args.length > 0 ? args[0] : "";
        if (typeof first === "string" && first.startsWith(prefix)) {
            origLog.apply(console, args);
        }
        // else: dropped
    };
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
const SLIDER_VALUES        = [0, 1, 2, 3, 4, 6, -1]; // 0=dot, -1=wicket
// Base zone weights (equal). Indices map to SLIDER_VALUES: 0=dot, 1=1, 2=2, 3=3, 4=4, 5=6, 6=wicket
const BASE_ZONE_WEIGHTS    = [1, 1, 1, 1, 1, 1, 1];
// Max shift from card modifiers: ±15% of total zone width
const MAX_CARD_ADVANTAGE   = 0.15;

// ── Pattern Templates ──────────────────────────────────────────────────────
// Each template defines a named pattern with boxes (value, width, colorHex).
// Server selects template based on bowler type and applies power modifications.

interface PatternBox { value: number; width: number; colorHex: string; }
interface PatternTemplate { name: string; shape: "StraightLine" | "Ring"; boxes: PatternBox[]; }

const FAST_TEMPLATES: PatternTemplate[] = [
    {
        name: "Yorker", shape: "StraightLine", boxes: [
            { value: 0, width: 0.15, colorHex: "#808080" },
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 2, width: 0.12, colorHex: "#00BFFF" },
            { value: 4, width: 0.10, colorHex: "#32CD32" },
            { value: 6, width: 0.08, colorHex: "#FFD700" },
            { value: -1, width: 0.10, colorHex: "#FF0000" },
        ],
    },
    {
        name: "Bouncer", shape: "StraightLine", boxes: [
            { value: 0, width: 0.12, colorHex: "#808080" },
            { value: 1, width: 0.10, colorHex: "#FFFFFF" },
            { value: 4, width: 0.12, colorHex: "#32CD32" },
            { value: 6, width: 0.10, colorHex: "#FFD700" },
            { value: -1, width: 0.14, colorHex: "#FF0000" },
            { value: 2, width: 0.10, colorHex: "#00BFFF" },
        ],
    },
    {
        name: "Inswinger", shape: "StraightLine", boxes: [
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 0, width: 0.15, colorHex: "#808080" },
            { value: 4, width: 0.10, colorHex: "#32CD32" },
            { value: -1, width: 0.12, colorHex: "#FF0000" },
            { value: 6, width: 0.08, colorHex: "#FFD700" },
            { value: 3, width: 0.10, colorHex: "#1E90FF" },
        ],
    },
    // ── Must match client PatternGenerator.FastTemplates order ──
    {
        name: "Full Toss", shape: "StraightLine", boxes: [
            { value: 4, width: 0.08, colorHex: "#32CD32" },
            { value: 6, width: 0.06, colorHex: "#FFD700" },
            { value: 2, width: 0.12, colorHex: "#00BFFF" },
            { value: 3, width: 0.10, colorHex: "#1E90FF" },
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 0, width: 0.15, colorHex: "#808080" },
        ],
    },
    {
        name: "Fast Straight", shape: "StraightLine", boxes: [
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 2, width: 0.12, colorHex: "#00BFFF" },
            { value: 3, width: 0.10, colorHex: "#1E90FF" },
            { value: 4, width: 0.08, colorHex: "#32CD32" },
            { value: 6, width: 0.06, colorHex: "#FFD700" },
            { value: -1, width: 0.10, colorHex: "#FF0000" },
        ],
    },
];

const SPIN_TEMPLATES: PatternTemplate[] = [
    {
        name: "Googly Trap", shape: "Ring", boxes: [
            { value: 0, width: 0.14, colorHex: "#808080" },
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 2, width: 0.12, colorHex: "#00BFFF" },
            { value: 4, width: 0.10, colorHex: "#32CD32" },
            { value: 6, width: 0.08, colorHex: "#FFD700" },
            { value: -1, width: 0.12, colorHex: "#FF0000" },
        ],
    },
    {
        name: "Doosra", shape: "Ring", boxes: [
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 0, width: 0.14, colorHex: "#808080" },
            { value: -1, width: 0.12, colorHex: "#FF0000" },
            { value: 4, width: 0.10, colorHex: "#32CD32" },
            { value: 6, width: 0.08, colorHex: "#FFD700" },
            { value: 2, width: 0.10, colorHex: "#00BFFF" },
        ],
    },
    // ── Must match client PatternGenerator.SpinTemplates order ���─
    {
        name: "Leg Break", shape: "Ring", boxes: [
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 3, width: 0.10, colorHex: "#1E90FF" },
            { value: -1, width: 0.10, colorHex: "#FF0000" },
            { value: 2, width: 0.12, colorHex: "#00BFFF" },
            { value: 6, width: 0.06, colorHex: "#FFD700" },
            { value: 0, width: 0.15, colorHex: "#808080" },
        ],
    },
    {
        name: "Carrom Ball", shape: "Ring", boxes: [
            { value: 0, width: 0.15, colorHex: "#808080" },
            { value: 4, width: 0.08, colorHex: "#32CD32" },
            { value: -1, width: 0.10, colorHex: "#FF0000" },
            { value: 1, width: 0.12, colorHex: "#FFFFFF" },
            { value: 3, width: 0.10, colorHex: "#1E90FF" },
            { value: 2, width: 0.12, colorHex: "#00BFFF" },
        ],
    },
];

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

/** Generate a pattern for this ball using a seeded RNG. */
function generatePattern(seed: number, bowlerType: string, activePowers: string[]): PatternTemplate {
    const rng = seededRandom(seed);
    const templates = bowlerType === "spin" ? SPIN_TEMPLATES : FAST_TEMPLATES;
    const idx = Math.floor(rng() * templates.length);
    const base = templates[idx];

    // Deep clone boxes
    const boxes: PatternBox[] = base.boxes.map(b => ({ ...b }));

    // Apply power modifications
    for (const power of activePowers) {
        switch (power) {
            case "PressureAura":
                // Shrink 4-run and 6-run boxes
                for (const box of boxes) {
                    if (box.value === 4) box.width *= 0.8;
                    if (box.value === 6) box.width *= 0.7;
                }
                break;
            case "ShieldWicket":
                // Remove wicket boxes (convert to dot)
                for (const box of boxes) {
                    if (box.value === -1) { box.value = 0; box.colorHex = "#808080"; }
                }
                break;
            case "DoubleScore":
                // Enlarge 6-run boxes
                for (const box of boxes) {
                    if (box.value === 6) box.width *= 1.3;
                }
                break;
        }
    }

    // Shuffle box order with seeded RNG (Fisher-Yates)
    for (let i = boxes.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [boxes[i], boxes[j]] = [boxes[j], boxes[i]];
    }

    return { name: base.name, shape: base.shape, boxes };
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
const BOT_TAP_MIN          = 0.05;
const BOT_TAP_MAX          = 0.85;

// ── Bot Default Deck ────────────────────────────────────────────────────────
const BOT_TEAM = {
    teamId: "bot_team",
    // 3 batsmen per team → maxWickets = battingPlayers.length - 1 = 2 wickets ends innings.
    // Rule: last batsman can't bat alone, so innings ends after N-1 wickets.
    battingPlayers: [
        { playerId: "bot_bat1", name: "Bot Batsman 1", role: "BattingStrategy", rarity: "Common", powerType: "", basePower: 1, level: 1 },
        { playerId: "bot_bat2", name: "Bot Batsman 2", role: "BattingDefense",  rarity: "Common", powerType: "", basePower: 1, level: 1 },
        { playerId: "bot_bat3", name: "Bot Batsman 3", role: "BattingStrategy", rarity: "Common", powerType: "", basePower: 1, level: 1 },
    ],
    bowlingPlayers: [
        { playerId: "bot_bow1", name: "Bot Bowler 1", role: "BowlingFast", rarity: "Common", powerType: "", basePower: 1, level: 1 },
        { playerId: "bot_bow2", name: "Bot Bowler 2", role: "BowlingSpin", rarity: "Common", powerType: "", basePower: 1, level: 1 },
    ],
};

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
    private static TRACE_ENABLED = true;
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

    // ── Toss timeout timer ───────────────────────────────────────────────────
    private tossTimer: any = null;

    // ── Match duration tracking ──────────────────────────────────────────────
    private matchStartedAt = 0;

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

    // ── Bowler pattern choice tracking ───────────────────────────────────────
    private patternSeed          = 0;
    private chosenPatternIndex   = 0;
    private currentBowlerType    = "fast";

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
        this.onMessage("fielder_tap",           (c, m) => this.handleFielderTap(c, m));
        this.onMessage("forfeit",               (c)    => this.handleForfeit(c));
        this.onMessage("heartbeat",      (c)    => c.send("heartbeat_ack", {}));

        // ── PTT (Push-to-Talk) ────────────────────────────────────────────────
        const PTT_MAX_BYTES = 65536; // ~3 s of PCM16 at 11025 Hz mono
        const pttLastSent   = new Map<string, number>();

        this.onMessage("voice_chunk", (client, data: ArrayBuffer) => {
            if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;
            if (data.byteLength > PTT_MAX_BYTES) return;
            const now  = Date.now();
            const last = pttLastSent.get(client.sessionId) ?? 0;
            if (now - last < 100) return; // max 10 chunks/s per client
            pttLastSent.set(client.sessionId, now);
            this.broadcast("voice_chunk", data, { except: client });
        });

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

    onJoin(client: Client, options: any) {
        const p             = new PlayerState();
        p.sessionId         = client.sessionId;
        p.playerId          = options.playerId   || client.sessionId;
        p.name              = options.playerName || "Player";
        p.elo               = options.elo        || 1000;
        p.teamId            = options.teamId || options.deckId || "";
        p.connected         = true;
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
        this.broadcast("player_joined", { playerId: p.playerId, playerName: p.name, elo: p.elo });

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

        // Remove from online presence (bot sessions are excluded)
        if (!p.playerId.startsWith("bot_")) {
            onlinePlayers.delete(p.playerId);
        }

        this.trace("onLeave", "SEND", "player_disconnected", { playerId: p.playerId, graceSeconds: 30 });
        this.broadcast("player_disconnected", { playerId: p.playerId, graceSeconds: 30 });

        // Notify WebRTC peers that this client disconnected
        onPeerDisconnected(this, client);

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
        if (this.state.phase !== "deck_confirm") return;
        const player = this.state.players.get(client.sessionId);
        if (!player || player.ready) return;

        // Support both old (battingCards/bowlingCards) and new (battingPlayers/bowlingPlayers) field names
        const bc = msg.battingPlayers || msg.battingCards || [];
        const bw = msg.bowlingPlayers || msg.bowlingCards || [];

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

        this.teamReadyCount++;
        if (this.teamReadyCount >= 2) this.startInnings(1);
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
        if (battingPlayer && (battingPlayer.battingPlayers?.length ?? 0) < minBatMW) {
            const existing = battingPlayer.battingPlayers?.length ?? 0;
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
            console.log(`[MatchRoom] Innings ${num} — padded batting roster ${existing}→${battingPlayer.battingPlayers.length} (min=${minBatMW}).`);
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
        console.log(`[MatchRoom] Innings ${num} — batting team has ${battingCardCount} batsmen → maxWickets=${this.state.maxWickets}`);

        this.state.phase = `innings${num}`;
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
            // Filter bowlers who haven't hit the 2-over cap
            availableBowlerIds = allBowlers
                .filter((c: TeamPlayer) => (this.bowlerOversBowled.get(c.playerId) || 0) < 2)
                .map((c: TeamPlayer) => c.playerId);
            if (availableBowlerIds.length > 1) {
                requiresBowlerSelection = true;
                bowlerActiveCardId = availableBowlerIds[0]; // default; UI may change
            } else {
                bowlerActiveCardId = availableBowlerIds[0] || allBowlers[0]?.playerId || "";
                this.currentOverBowlerId = bowlerActiveCardId;
            }
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
    private applyBundledActivations(sid: string, cardId: string, powerIds: string[]) {
        const player = this.state.players.get(sid);
        if (!player) return;
        for (const powerType of powerIds) {
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

            if (powerType === "SpeedBoost") {
                this.state.currentBallArrowSpeed *= 1.5;
            }

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

    private handleSelectBowler(client: Client, msg: { playerId?: string; cardId?: string; activatedPowerIds?: string[] }) {
        if (!this.cardSelectsPending.bowler) return;
        const chosenCard = msg.playerId || msg.cardId || "";
        const powers = Array.isArray(msg.activatedPowerIds) ? msg.activatedPowerIds : [];
        this.bowlerPlayerId = chosenCard;
        this.pendingBundledPowers.bowler = powers;
        this.applyBundledActivations(client.sessionId, chosenCard, powers);
        this.cardSelectsPending.bowler = false;

        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        if (!this.cardSelectsPending.batsman) {
            this.ballTimer?.clear();
            this.advanceAfterBothCardSelects(bSid, wSid);
        }
    }

    private handleSelectBatsman(client: Client, msg: { playerId?: string; cardId?: string; activatedPowerIds?: string[] }) {
        if (!this.cardSelectsPending.batsman) return;
        const chosenCard = msg.playerId || msg.cardId || "";
        const powers = Array.isArray(msg.activatedPowerIds) ? msg.activatedPowerIds : [];
        this.batsmanPlayerId = chosenCard;
        this.pendingBundledPowers.batsman = powers;
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

    // ── Bowler Pattern Choice Phase ─────────────────────────────────────────

    /**
     * After both cards are selected, prompt the bowler to choose one of two
     * pattern options.  The client generates the two options from seed and
     * seed+1 using the same PatternGenerator logic, so we only send the seed.
     */
    private promptBowlerPattern(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;

        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        this.currentBowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        // Deterministic seed for this ball — use >>> 0 to ensure unsigned 32-bit
        // (JS bitwise ^ truncates Date.now() to signed 32-bit, which is negative in 2025+)
        const patternSeedPre  = Date.now() ^ (ballNumber * 1000 + over * 100); // signed
        const patternSeedPost = patternSeedPre >>> 0;                          // unsigned
        this.trace("promptBowlerPattern", "SEED", "seed_discipline", { patternSeedPre, patternSeedPost, preIsNegative: patternSeedPre < 0, postIsPositive: patternSeedPost > 0, ballNumber, over });
        this.patternSeed        = patternSeedPost;
        this.chosenPatternIndex = 0; // default to option 0

        // Pre-generate both pattern options with the exact power flags that
        // will apply when the ball is bowled (bundled activations from both
        // sides + passives). Previews now match reality.
        const previewPowerFlags = this.collectBallPowerFlags(battingSid, bowlingSid);
        const patternA = generatePattern(this.patternSeed,     this.currentBowlerType, previewPowerFlags);
        const patternB = generatePattern(this.patternSeed + 1, this.currentBowlerType, previewPowerFlags);

        this.state.awaitingBowlerPattern = true;

        // Send both pre-built patterns to bowler, wait signal to batsman
        const bowlerClient  = this.clients.find(c => c.sessionId === bowlingSid);
        const batsmanClient = this.clients.find(c => c.sessionId === battingSid);
        const bowlerCid  = this._mintCid();
        const batsmanCid = this._mintCid();
        this.trace("promptBowlerPattern", "SEND", "bowler_pattern_prompt", { cid: bowlerCid, recipient: "bowler", recipientSid: bowlingSid, seed: this.patternSeed, bowlerType: this.currentBowlerType, hasOptA: !!patternA, hasOptB: !!patternB, ballNumber, over });
        bowlerClient?.send("bowler_pattern_prompt", {
            cid: bowlerCid,
            role: "bowler",
            seed: this.patternSeed, bowlerType: this.currentBowlerType,
            timeoutSeconds: PATTERN_SELECT_TIMEOUT / 1000,
            patternOptionA: patternA,
            patternOptionB: patternB,
        });
        this.trace("promptBowlerPattern", "SEND", "bowler_pattern_prompt", { cid: batsmanCid, recipient: "batsman", recipientSid: battingSid, seed: -1, bowlerType: this.currentBowlerType, ballNumber, over });
        batsmanClient?.send("bowler_pattern_prompt", {
            cid: batsmanCid,
            role: "batsman",
            seed: -1, bowlerType: this.currentBowlerType,
            timeoutSeconds: PATTERN_SELECT_TIMEOUT / 1000,
        });

        // Timeout: auto-select option 0
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.state.awaitingBowlerPattern) {
                this.state.awaitingBowlerPattern = false;
                this.chosenPatternIndex = 0;
                this.startBall(battingSid, bowlingSid);
            }
        }, this.t(PATTERN_SELECT_TIMEOUT));

        // Bot auto-selects pattern
        if (this.isBot && bowlingSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (!this.state.awaitingBowlerPattern) return;
                this.ballTimer?.clear();
                this.state.awaitingBowlerPattern = false;
                this.chosenPatternIndex = Math.random() < 0.5 ? 0 : 1;
                this.startBall(battingSid, bowlingSid);
            }, BOT_RESPONSE_DELAY);
        }
    }

    private handleBowlerPatternChoice(client: Client, msg: { optionIndex: number }) {
        if (!this.state.awaitingBowlerPattern) return;
        this.ballTimer?.clear();
        this.state.awaitingBowlerPattern = false;
        this.chosenPatternIndex = msg.optionIndex === 1 ? 1 : 0;

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

        // ── Apply passive powers from selected cards ──
        let arrowSpeed = this.state.currentBallArrowSpeed;
        const allPowerFlags: string[] = [];

        if (bowlerCard?.powerType === "PressureAura") {
            arrowSpeed *= 1.25;
            allPowerFlags.push("PressureAura");
        }
        if (batsmanCard?.powerType === "SteadyHand") {
            arrowSpeed *= 0.85;
            allPowerFlags.push("SteadyHand");
        }
        if (batsmanCard?.powerType === "ColourCode")     allPowerFlags.push("ColourCode");
        if (batsmanCard?.powerType === "PredictionLine") allPowerFlags.push("PredictionLine");

        // ── Apply triggered powers already activated for this ball ──
        arrowSpeed = Math.max(arrowSpeed, this.state.currentBallArrowSpeed);

        const hasTimeFreeze = this.isPowerActiveThisBall("TimeFreeze", battingSid);
        const hasGhostBall  = this.isPowerActiveThisBall("GhostBall", bowlingSid);
        if (hasTimeFreeze) allPowerFlags.push("TimeFreeze");
        if (hasGhostBall)  allPowerFlags.push("GhostBall");

        const effectiveTimeout = hasTimeFreeze ? BALL_TIMEOUT_MS + 1000 : BALL_TIMEOUT_MS;

        // ── Generate pattern from seed (uses bowler's chosen index) ──
        const effectiveSeed = this.patternSeed + this.chosenPatternIndex;
        const pattern = generatePattern(effectiveSeed, bowlerType, allPowerFlags);
        this.currentPatternBoxes = pattern.boxes;

        // Build activePowers array for client
        const activePowers = allPowerFlags.map(p => ({
            powerId: p, cardId: "", effectValue: 0,
        }));

        this.state.awaitingBatsmanTap = true;
        const ballStartCid = this._mintCid();
        // Striker / non-striker card IDs for the live-player HUD. Server currently
        // picks batsmanPlayerId = battingPlayers[0], so non-striker is battingPlayers[1]
        // (fallback to any other batsman when rotation lands the striker at [1]).
        const ballStartBattingTeam = this.state.players.get(battingSid);
        const battingRoster        = ballStartBattingTeam?.battingPlayers ? Array.from(ballStartBattingTeam.battingPlayers) : [];
        const strikerCardId        = this.batsmanPlayerId || battingRoster[0]?.playerId || "";
        const nonStrikerCardId     = battingRoster.find((c: TeamPlayer) => c.playerId !== strikerCardId)?.playerId || "";
        this.trace("startBall", "SEND", "ball_start", { cid: ballStartCid, ballNumber, over, ballInOver, arrowSpeed, bowlerType, patternSeed: effectiveSeed, patternName: pattern.name, patternShape: pattern.shape, boxCount: pattern.boxes?.length, activePowers: allPowerFlags.join(","), strikerCardId, nonStrikerCardId, bowlerCardId: this.bowlerPlayerId });
        this.broadcast("ball_start", {
            cid: ballStartCid,
            ballNumber, over, ballInOver, arrowSpeed,
            timeoutSeconds: effectiveTimeout / 1000,
            bowlerPlayerId: this.bowlerPlayerId, bowlerType,
            // Live-player HUD card IDs (striker / non-striker / bowler)
            strikerCardId, nonStrikerCardId, bowlerCardId: this.bowlerPlayerId,
            // Pattern system fields
            patternSeed: effectiveSeed, patternName: pattern.name,
            patternShape: pattern.shape,
            patternBoxes: pattern.boxes,
            serverStartTime: Date.now() / 1000,
            activePowers,
            // Legacy flags (kept for backward compatibility)
            ghostBall: hasGhostBall,
            timeFreeze: hasTimeFreeze,
        });
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.state.awaitingBatsmanTap) this.resolveBall(0.0, battingSid, bowlingSid);
        }, this.t(effectiveTimeout));

        // Bot auto-taps if it's the batsman
        if (this.isBot && battingSid === this.botSid) {
            this.scheduleBotAction();
        }
    }

    private handleBatsmanTap(client: Client, msg: { position: number, hitValue?: number }) {
        if (!this.state.awaitingBatsmanTap) return;
        this.ballTimer?.clear();
        this.state.awaitingBatsmanTap = false;
        this.lastBatsmanTapPosition = msg.position;
        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.resolveBall(msg.position, bSid, wSid, msg.hitValue);
    }

    // ── Card Modifier: Zone Boundary Calculation ────────────────────────────

    /**
     * Computes dynamic zone boundaries based on batting vs bowling card strength.
     * Returns an array of cumulative boundary thresholds [0..1].
     * - Batting advantage → widens 4-run and 6-run zones, shrinks wicket zone
     * - Bowling advantage → widens wicket and dot zones, shrinks 4/6 zones
     */
    private computeZoneBoundaries(battingSid: string, bowlingSid: string): number[] {
        const batsmanCard = this.state.players.get(battingSid)?.battingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.batsmanPlayerId);
        const bowlerCard  = this.state.players.get(bowlingSid)?.bowlingPlayers
            ?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);

        const batStrength  = (batsmanCard?.basePower ?? 1) * (1 + ((batsmanCard?.level ?? 1) - 1) * 0.1);
        const bowlStrength = (bowlerCard?.basePower  ?? 1) * (1 + ((bowlerCard?.level  ?? 1) - 1) * 0.1);

        // advantage > 0 means batsman is stronger; < 0 means bowler is stronger
        const rawAdvantage = (batStrength - bowlStrength) / 10;
        const advantage    = Math.max(-MAX_CARD_ADVANTAGE, Math.min(MAX_CARD_ADVANTAGE, rawAdvantage));

        // SLIDER_VALUES = [0, 1, 2, 3, 4, 6, -1]
        // Adjust weights: indices 4(=4 runs), 5(=6 runs) benefit from batting advantage
        //                 index 6(=wicket), 0(=dot) benefit from bowling advantage
        const weights = [...BASE_ZONE_WEIGHTS];
        weights[4] += advantage * 3;  // 4-run zone
        weights[5] += advantage * 3;  // 6-run zone
        weights[6] -= advantage * 3;  // wicket zone
        weights[0] -= advantage * 3;  // dot zone

        // Bot bowling: rare wickets. Shrink wicket zone by configured factor (Firestore-driven).
        const botBowling = this.isBot && bowlingSid === this.botSid;
        if (botBowling) {
            weights[6] *= this.botWicketZoneFactor;
        }

        // Clamp weights to minimum 0.2 (zones never vanish entirely)
        // Exception: bot wicket zone may shrink below 0.2 to enforce rarity.
        for (let i = 0; i < weights.length; i++) {
            const floor = (botBowling && i === 6) ? 0.02 : 0.2;
            weights[i] = Math.max(floor, weights[i]);
        }

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const boundaries: number[] = [];
        let cumulative = 0;
        for (let i = 0; i < weights.length; i++) {
            cumulative += weights[i] / totalWeight;
            boundaries.push(cumulative);
        }
        boundaries[boundaries.length - 1] = 1.0; // ensure last boundary is exactly 1.0
        return boundaries;
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
        const innings = this.activeInnings();

        // Resolve tap against pattern boxes if available, else fall back to zone boundaries.
        // If the client reported the visually-detected hit box value (clientHitValue), trust
        // it when it's valid (not the -999 sentinel and matches a value in the current pattern).
        // This fixes visual/server mismatch where the slider stopped on one box but the
        // position-based math resolved to a neighbouring zone.
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
            const boundaries = this.computeZoneBoundaries(battingSid, bowlingSid);
            let zone = boundaries.length - 1;
            for (let i = 0; i < boundaries.length; i++) {
                if (position < boundaries[i]) { zone = i; break; }
            }
            value = SLIDER_VALUES[zone];
        }

        let outcome = "dot", runs = 0, originalRuns = 0;
        const powersApplied: string[] = [];

        if (value === -1) {
            outcome = "wicket";

            // ── ShieldWicket: convert wicket → dot ball ──
            if (this.isPowerActiveThisBall("ShieldWicket", battingSid)) {
                outcome = "dot";
                runs = 0;
                powersApplied.push("ShieldWicket");
            } else {
                innings.wickets++;
            }
        } else if (value > 0) {
            outcome = "run";
            runs = value;
            originalRuns = runs;

            // ── DoubleScore: double the run value ──
            if (this.isPowerActiveThisBall("DoubleScore", battingSid)) {
                runs *= 2;
                powersApplied.push("DoubleScore");
            }

            innings.score += runs;
        }

        // ── ExtraLife: if wicket still stands, check for ExtraLife ──
        if (outcome === "wicket" && this.isPowerActiveThisBall("ExtraLife", battingSid)) {
            // Cancel the wicket
            innings.wickets--;
            outcome = "dot";
            runs = 0;
            powersApplied.push("ExtraLife");
        }

        // ── Catch phase: on boundaries (4 or 6), probabilistic catch opportunity ──
        if (outcome === "run" && (value === 4 || value === 6) && this.shouldTriggerCatch(value, bowlingSid)) {
            this.pendingCatchResult = {
                value, runs, originalRuns, outcome,
                powersApplied: powersApplied.join(","),
                battingSid, bowlingSid,
            };
            this.startCatchPhase(battingSid, bowlingSid);
            return; // Ball not recorded yet — resolveCatch() will finish it
        }

        innings.ballsBowled++;
        const overJustCompleted = innings.ballsBowled % this.state.ballsPerOver === 0;
        if (overJustCompleted) innings.currentOver++;

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
        const maxBalls = overs * this.state.ballsPerOver;
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

        // Send to fielder (bowler) as interactive, batsman as read-only
        const bowlerClient  = this.clients.find(c => c.sessionId === bowlingSid);
        const batsmanClient = this.clients.find(c => c.sessionId === battingSid);
        this.trace("startCatchPhase", "SEND", "catch_start", { recipient: "fielder", recipientSid: bowlingSid, bowlerType, isFielderView: true, strikePosition: this.lastBatsmanTapPosition });
        bowlerClient?.send("catch_start",  { ...catchMsg, isFielderView: true });
        this.trace("startCatchPhase", "SEND", "catch_start", { recipient: "batsman", recipientSid: battingSid, bowlerType, isFielderView: false, strikePosition: this.lastBatsmanTapPosition });
        batsmanClient?.send("catch_start", { ...catchMsg, isFielderView: false });

        // Timeout: auto-miss
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.state.awaitingFielderTap) {
                this.resolveCatch(false);
            }
        }, this.t(CATCH_PHASE_TIMEOUT));

        // Bot auto-attempts catch
        if (this.isBot && bowlingSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (!this.state.awaitingFielderTap) return;
                this.ballTimer?.clear();
                const isCatch = Math.random() < this.botCatchRate;
                this.resolveCatch(isCatch);
            }, BOT_RESPONSE_DELAY + Math.random() * 500);
        }
    }

    private handleFielderTap(client: Client, msg: { isCatch: boolean }) {
        if (!this.state.awaitingFielderTap) return;
        // Validate sender is the bowling/fielding player
        const pending = this.pendingCatchResult;
        if (!pending || client.sessionId !== pending.bowlingSid) return;
        this.ballTimer?.clear();
        this.resolveCatch(!!msg.isCatch);
    }

    /** Finalize ball after catch attempt. Reverses runs if caught. */
    private resolveCatch(isCatch: boolean) {
        this.state.awaitingFielderTap = false;
        const pending = this.pendingCatchResult;
        if (!pending) return;

        const innings = this.activeInnings();
        let { runs, originalRuns, outcome, powersApplied, battingSid, bowlingSid } = pending;

        if (isCatch) {
            // Reverse the runs that were tentatively added
            innings.score -= runs;
            innings.wickets++;
            outcome = "catch";
            runs = 0;
        }
        // If dropped, runs remain as they were

        // Record ball
        innings.ballsBowled++;
        const overJustCompleted = innings.ballsBowled % this.state.ballsPerOver === 0;
        if (overJustCompleted) innings.currentOver++;

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
        const maxBalls = overs * this.state.ballsPerOver;
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

        this.clock.setTimeout(() => this.disconnect(), 5000);
    }

    /** Standard ELO delta calculation using K-factor. */
    private calculateEloDelta(winnerElo: number, loserElo: number): number {
        const expectedWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
        return Math.round(ELO_K_FACTOR * (1 - expectedWin));
    }

    // ── Powers / Forfeit ────────────────────────────────────────────────────

    /**
     * Validates and registers a triggered power activation for the current ball.
     * Passive powers are auto-applied in startBall/resolveBall based on card powerType.
     */
    /**
     * Collects all active power flags for the upcoming ball, used to generate
     * an accurate pattern preview. Includes:
     *   - passive powers from the active bowler + batsman cards
     *   - triggered powers bundled in the current ball's card-select replies
     */
    private collectBallPowerFlags(battingSid: string, bowlingSid: string): string[] {
        const flags: string[] = [];
        const batter  = this.state.players.get(battingSid);
        const bowler  = this.state.players.get(bowlingSid);
        const bowlerCard  = bowler?.bowlingPlayers?.find((c: TeamPlayer) => c.playerId === this.bowlerPlayerId);
        const batsmanCard = batter?.battingPlayers?.find((c: TeamPlayer) => c.playerId === this.batsmanPlayerId);
        if (bowlerCard?.powerType  === "PressureAura") flags.push("PressureAura");
        if (batsmanCard?.powerType === "SteadyHand")   flags.push("SteadyHand");
        if (batsmanCard?.powerType === "ColourCode")     flags.push("ColourCode");
        if (batsmanCard?.powerType === "PredictionLine") flags.push("PredictionLine");
        for (const [key, _] of this.activePowersThisBall) {
            const powerId = key.split(":")[0];
            if (!flags.includes(powerId)) flags.push(powerId);
        }
        return flags;
    }

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

        // Apply immediate effects (SpeedBoost modifies arrow speed before ball starts)
        if (powerType === "SpeedBoost") {
            this.state.currentBallArrowSpeed *= 1.5;
        }

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
     */
    private injectBot(options: any) {
        this.botSid = BOT_SESSION_ID;
        const bot           = new PlayerState();
        bot.sessionId       = this.botSid;
        bot.playerId        = `bot_${this.roomId}`;
        const rawBotName    = options.botName || `Player${Math.floor(Math.random() * 1000)}`;
        bot.name            = rawBotName.startsWith("bot_") ? rawBotName : `bot_${rawBotName}`;
        bot.elo             = options.elo     || 1000;
        bot.teamId          = "bot_team";
        bot.connected       = true;
        this.state.players.set(this.botSid, bot);

        this.trace("injectBot", "SEND", "player_joined", { playerId: bot.playerId, playerName: bot.name, elo: bot.elo, isBot: true });
        this.broadcast("player_joined", { playerId: bot.playerId, playerName: bot.name, elo: bot.elo });
        slog("MatchRoom", "bot_injected", { name: bot.name, elo: bot.elo });

        // If human is already in, start toss
        if (this.state.players.size >= 2) {
            this.startToss();
        }
    }

    /** Bot confirms its deck during the deck_confirm phase. */
    private botConfirmDeck() {
        if (this.state.phase !== "deck_confirm") return;
        const bot = this.state.players.get(this.botSid);
        if (!bot || bot.ready) return;

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

        bot.teamId          = BOT_TEAM.teamId;
        bot.battingPlayers  = new ArraySchema<TeamPlayer>(...BOT_TEAM.battingPlayers.map(toPlayer));
        bot.bowlingPlayers  = new ArraySchema<TeamPlayer>(...BOT_TEAM.bowlingPlayers.map(toPlayer));
        bot.ready         = true;

        this.teamReadyCount++;
        if (this.teamReadyCount >= 2) this.startInnings(1);
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
                    const cardIdx = Math.floor(Math.random() * (bot?.bowlingPlayers?.length || 1));
                    this.bowlerPlayerId = bot?.bowlingPlayers?.[cardIdx]?.playerId || "bot_bow1";
                    this.state.awaitingBowlerSelection = false;
                    const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
                    const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
                    this.promptBothPowerSelection(bSid, wSid);
                }, BOT_RESPONSE_DELAY);
            }
            return;
        }

        // Bot needs to tap as batsman
        if (this.state.awaitingBatsmanTap) {
            const innings = this.activeInnings();
            const batSid = innings.battingPlayerId === this.state.players.get(this.botSid)?.playerId
                ? this.botSid : null;
            if (batSid) {
                this.clock.setTimeout(() => {
                    if (!this.state.awaitingBatsmanTap) return;
                    this.ballTimer?.clear();
                    this.state.awaitingBatsmanTap = false;
                    // Bot taps at a random position (skill varies)
                    const pos = BOT_TAP_MIN + Math.random() * (BOT_TAP_MAX - BOT_TAP_MIN);
                    this.lastBatsmanTapPosition = pos;
                    const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
                    const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
                    this.resolveBall(pos, bSid, wSid);
                }, BOT_RESPONSE_DELAY + Math.random() * 500);
            }
        }
    }
}
