import { Room, Client } from "colyseus";
import { ArraySchema } from "@colyseus/schema";
import {
    MatchRoomState, PlayerState, InningsData,
    BallState, DeckCard, PowerSlot, PowerUsage,
} from "./schema/MatchRoomState.js";

const TOSS_TIMEOUT_MS      = 15_000;
const TOSS_DECISION_TIMEOUT_MS = 10_000;
const CARD_SELECT_TIMEOUT  = 10_000;
const BALL_TIMEOUT_MS      = 8_000;
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
const BOT_TAP_MIN          = 0.05;
const BOT_TAP_MAX          = 0.85;

// ── Bot Default Deck ────────────────────────────────────────────────────────
const BOT_DECK = {
    deckId: "bot_deck",
    battingCards: [
        { cardId: "bot_bat1", name: "Bot Batsman 1", role: "BattingStrategy", rarity: "Common", powerType: "", basePower: 1, level: 1 },
        { cardId: "bot_bat2", name: "Bot Batsman 2", role: "BattingDefense",  rarity: "Common", powerType: "", basePower: 1, level: 1 },
    ],
    bowlingCards: [
        { cardId: "bot_bow1", name: "Bot Bowler 1", role: "BowlingFast", rarity: "Common", powerType: "", basePower: 1, level: 1 },
        { cardId: "bot_bow2", name: "Bot Bowler 2", role: "BowlingSpin", rarity: "Common", powerType: "", basePower: 1, level: 1 },
    ],
};

// ── Power Effect Definitions ─────────────────────────────────────────────
// Maps powerType string (from DeckCard.powerType) to its server-side config.
// Client sends powerType as the powerId in power_activate messages.

interface PowerConfig {
    /** Who can use it: "batsman" | "bowler" */
    role: "batsman" | "bowler";
    /** passive = always active when card is in play; triggered = manual activation */
    activation: "passive" | "triggered";
    /** Max times a triggered power can be used per match (per card) */
    maxUsesPerMatch: number;
    /** Description for logging */
    label: string;
}

const POWER_CONFIGS: Record<string, PowerConfig> = {
    // ── Passive powers (auto-applied when card is selected) ──
    ColourCode:     { role: "batsman", activation: "passive",    maxUsesPerMatch: 999, label: "Colour Code" },
    PredictionLine: { role: "batsman", activation: "passive",    maxUsesPerMatch: 999, label: "Prediction Line" },
    PressureAura:   { role: "bowler",  activation: "passive",    maxUsesPerMatch: 999, label: "Pressure Aura" },
    SteadyHand:     { role: "batsman", activation: "passive",    maxUsesPerMatch: 999, label: "Steady Hand" },
    // ── Triggered powers (player must activate) ──
    DoubleScore:    { role: "batsman", activation: "triggered",  maxUsesPerMatch: 2,   label: "2x Score" },
    ShieldWicket:   { role: "batsman", activation: "triggered",  maxUsesPerMatch: 2,   label: "Shield Wicket" },
    SpeedBoost:     { role: "bowler",  activation: "triggered",  maxUsesPerMatch: 3,   label: "Speed Boost" },
    TimeFreeze:     { role: "batsman", activation: "triggered",  maxUsesPerMatch: 2,   label: "Time Freeze" },
    GhostBall:      { role: "bowler",  activation: "triggered",  maxUsesPerMatch: 2,   label: "Ghost Ball" },
    ExtraLife:      { role: "batsman", activation: "triggered",  maxUsesPerMatch: 1,   label: "Extra Life" },
};

/**
 * MatchRoom — room name "match_room"
 * Server-authoritative 1v1 cricket match. Full game loop:
 *   Lobby → Toss → DeckConfirm → Innings 1 → Break → Innings 2 → Result
 */
export class MatchRoom extends Room {
    declare state: MatchRoomState;
    maxClients  = 2;
    autoDispose = true;

    // Session IDs of batting / bowling players for each innings
    private battingSid = "";
    private bowlingSid = "";
    private currentInnings = 0;

    // Per-ball state
    private bowlerCardId  = "";
    private batsmanCardId = "";
    private ballTimer: any = null;

    // Deck confirm tracking
    private deckReadyCount = 0;

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

    // ── Bot tracking ─────────────────────────────────────────────────────────
    private isBot      = false;
    private botSid     = "";   // Session ID of the bot "player"

    // ── Lifecycle ───────────────────────────────────────────────────────────

    onCreate(options: any) {
        this.state = new MatchRoomState();
        this.state.matchId        = options.matchId    || this.roomId;
        this.state.oversPerMatch  = options.oversPerMatch || 3;
        this.state.ballsPerOver   = options.ballsPerOver  || 6;
        this.state.isPrivate      = options.isPrivate     || false;
        this.state.roomCode       = options.roomCode      || "";
        this.state.createdAt      = Date.now();
        this.isBot                = options.isBot         || false;

        this.onMessage("toss_choice",    (c, m) => this.handleTossChoice(c, m));
        this.onMessage("toss_bat_bowl",  (c, m) => this.handleTossBatBowl(c, m));
        this.onMessage("deck_confirm",   (c, m) => this.handleDeckConfirm(c, m));
        this.onMessage("select_bowler",  (c, m) => this.handleSelectBowler(c, m));
        this.onMessage("select_batsman", (c, m) => this.handleSelectBatsman(c, m));
        this.onMessage("batsman_tap",    (c, m) => this.handleBatsmanTap(c, m));
        this.onMessage("power_activate", (c, m) => this.handlePowerActivate(c, m));
        this.onMessage("forfeit",        (c)    => this.handleForfeit(c));
        this.onMessage("heartbeat",      (c)    => c.send("heartbeat_ack", {}));

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
        p.deckId            = options.deckId     || "";
        p.connected         = true;
        this.state.players.set(client.sessionId, p);

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
        this.broadcast("player_disconnected", { playerId: p.playerId, graceSeconds: 30 });

        this.allowReconnection(client, 30)
            .then(() => {
                const rp = this.state.players.get(client.sessionId);
                if (rp) rp.connected = true;
                this.broadcast("player_reconnected", { playerId: rp?.playerId });
            })
            .catch(() => this.endMatch(this.opponentOf(client.sessionId), client.sessionId, "disconnect"));
    }

    onDispose() {
        this.ballTimer?.clear();
        this.tossTimer?.clear();
        console.log(`[MatchRoom] ${this.roomId} disposed`);
    }

    // ── Toss ────────────────────────────────────────────────────────────────

    private startToss() {
        this.matchStartedAt = Date.now();
        this.state.phase = "toss_choice";
        const keys       = Array.from(this.state.players.keys());
        const callerSid  = keys[Math.floor(Math.random() * 2)];
        const caller     = this.state.players.get(callerSid)!;
        this.state.tossCaller = callerSid;
        this.broadcast("toss_screen", {
            callerId: caller.playerId, callerName: caller.name, timeoutSeconds: TOSS_TIMEOUT_MS / 1000,
        });

        // Toss choice timeout — auto-pick heads if caller doesn't respond
        this.tossTimer = this.clock.setTimeout(() => {
            if (this.state.phase === "toss_choice") {
                console.log(`[MatchRoom] Toss choice timeout for ${callerSid}, auto-picking heads`);
                this.handleTossChoiceInternal(callerSid, "heads");
            }
        }, TOSS_TIMEOUT_MS);

        // Bot auto-responds to toss if the bot is the caller
        if (this.isBot && callerSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (this.state.phase === "toss_choice") {
                    this.handleTossChoiceInternal(this.botSid, Math.random() < 0.5 ? "heads" : "tails");
                }
            }, BOT_RESPONSE_DELAY);
        }
    }

    private handleTossChoice(client: Client, msg: { choice: string }) {
        if (this.state.phase !== "toss_choice") return;
        if (client.sessionId !== this.state.tossCaller) return;
        this.handleTossChoiceInternal(client.sessionId, msg.choice);
    }

    private handleTossChoiceInternal(callerSid: string, choice: string) {
        if (this.state.phase !== "toss_choice") return;
        this.tossTimer?.clear();

        const coin   = Math.random() < 0.5 ? "heads" : "tails";
        const won    = choice === coin;
        const winSid = won ? callerSid : this.opponentOfSid(callerSid);
        const winner = this.state.players.get(winSid)!;

        this.state.tossWinner = winSid;
        this.state.phase      = "toss_decision";
        this.broadcast("toss_result", {
            coinResult: coin, callerCall: choice,
            winnerId: winner.playerId, winnerName: winner.name,
            message: `${winner.name} won the toss!`,
        });

        // Toss decision timeout — auto-pick "bat" if winner doesn't respond
        this.tossTimer = this.clock.setTimeout(() => {
            if (this.state.phase === "toss_decision") {
                console.log(`[MatchRoom] Toss decision timeout for ${winSid}, auto-picking bat`);
                this.handleTossBatBowlInternal(winSid, "bat");
            }
        }, TOSS_DECISION_TIMEOUT_MS);

        // Bot auto-responds to bat/bowl decision
        if (this.isBot && winSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (this.state.phase === "toss_decision") {
                    this.handleTossBatBowlInternal(this.botSid, Math.random() < 0.5 ? "bat" : "bowl");
                }
            }, BOT_RESPONSE_DELAY);
        }
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

        this.state.phase    = "deck_confirm";
        this.deckReadyCount = 0;
        this.broadcast("toss_decision", {
            winnerId: winner.playerId, winnerName: winner.name, choice,
            battingPlayerId: batter.playerId, bowlingPlayerId: bowler.playerId,
        });

        // Bot auto-confirms deck
        if (this.isBot) {
            this.clock.setTimeout(() => this.botConfirmDeck(), BOT_RESPONSE_DELAY);
        }
    }

    // ── Deck Confirm ────────────────────────────────────────────────────────

    private handleDeckConfirm(client: Client, msg: { deckId: string; battingCards: any[]; bowlingCards: any[] }) {
        if (this.state.phase !== "deck_confirm") return;
        const player = this.state.players.get(client.sessionId);
        if (!player || player.ready) return;

        const bc = msg.battingCards || [];
        const bw = msg.bowlingCards || [];

        // ── Server-side deck validation ──
        if (bc.length < 2) {
            client.send("deck_invalid", { error: "Deck requires at least 2 batting cards." });
            return;
        }
        if (bw.length < 2) {
            client.send("deck_invalid", { error: "Deck requires at least 2 bowling cards." });
            return;
        }

        // Bowling composition rules: min 1 Fast, max 2 Spin
        const fastCount = bw.filter((c: any) => (c.role || "").includes("Fast")).length;
        const spinCount = bw.filter((c: any) => (c.role || "").includes("Spin")).length;
        if (fastCount < 1) {
            client.send("deck_invalid", { error: "You need at least 1 Fast bowler." });
            return;
        }
        if (spinCount > 2) {
            client.send("deck_invalid", { error: "Maximum 2 Spin bowlers allowed." });
            return;
        }

        const toCard = (c: any): DeckCard => {
            const card     = new DeckCard();
            card.cardId    = c.cardId    || "";
            card.name      = c.name      || "";
            card.role      = c.role      || "";
            card.rarity    = c.rarity    || "";
            card.powerType = c.powerType || "";
            card.basePower = c.basePower || 1;
            card.level     = c.level     || 1;
            return card;
        };

        player.deckId       = msg.deckId || "";
        player.battingCards = new ArraySchema<DeckCard>(...bc.map(toCard));
        player.bowlingCards = new ArraySchema<DeckCard>(...bw.map(toCard));
        player.ready        = true;

        this.deckReadyCount++;
        if (this.deckReadyCount >= 2) this.startInnings(1);
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

        this.state.phase = `innings${num}`;
        this.broadcast("innings_start", {
            inningsNumber: num, isSuperOver: false,
            battingPlayerId: innings.battingPlayerId, bowlingPlayerId: innings.bowlingPlayerId,
            target: innings.target, oversPerInnings: this.state.oversPerMatch,
        });
        this.clock.setTimeout(() => this.promptBowlerCard(batting, bowling), 1500);
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
        this.broadcast("super_over_start", {
            reason: "tied",
            innings1Score: this.state.innings1.score,
            innings2Score: this.state.innings2.score,
        });

        // Start first super over innings after a short delay
        this.clock.setTimeout(() => this.startSuperOverInnings(1), 3000);
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

        this.broadcast("innings_start", {
            inningsNumber: num, isSuperOver: true,
            battingPlayerId: innings.battingPlayerId, bowlingPlayerId: innings.bowlingPlayerId,
            target: innings.target, oversPerInnings: 1,
        });
        this.clock.setTimeout(() => this.promptBowlerCard(batting, bowling), 1500);
    }

    private endSuperOverInnings() {
        const innings = this.activeSuperOverInnings();
        innings.isComplete = true;
        this.broadcast("innings_end", {
            inningsNumber: this.superOverInnings, isSuperOver: true,
            score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled,
        });

        if (this.superOverInnings === 1) {
            // Break before super over innings 2
            this.broadcast("innings_break", {
                innings1Score: innings.score, innings1Wickets: innings.wickets,
                innings1Balls: innings.ballsBowled, target: innings.score + 1, breakDuration: 3,
            });
            this.clock.setTimeout(() => this.startSuperOverInnings(2), 3000);
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

    private promptBowlerCard(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        this.state.awaitingBowlerSelection = true;
        this.state.awaitingBatsmanTap      = false;
        this.bowlerCardId  = "";
        this.batsmanCardId = "";

        const bowlerClient = this.clients.find(c => c.sessionId === bowlingSid);
        bowlerClient?.send("select_bowler_card", { ballNumber, over, ballInOver, timeoutSeconds: CARD_SELECT_TIMEOUT / 1000 });

        this.ballTimer = this.clock.setTimeout(() => {
            if (!this.bowlerCardId) {
                const bp = this.state.players.get(bowlingSid);
                this.bowlerCardId = bp?.bowlingCards?.[0]?.cardId || "default";
                this.state.awaitingBowlerSelection = false;
                this.promptBatsmanCard(battingSid, bowlingSid);
            }
        }, CARD_SELECT_TIMEOUT);

        // Bot auto-selects bowler card if it's the bowler
        if (this.isBot && bowlingSid === this.botSid) {
            this.scheduleBotAction();
        }
    }

    private handleSelectBowler(client: Client, msg: { cardId: string }) {
        if (!this.state.awaitingBowlerSelection) return;
        this.ballTimer?.clear();
        this.bowlerCardId = msg.cardId;
        this.state.awaitingBowlerSelection = false;
        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.promptBatsmanCard(bSid, wSid);
    }

    private promptBatsmanCard(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        const batsmanClient = this.clients.find(c => c.sessionId === battingSid);
        batsmanClient?.send("select_batsman_card", { ballNumber, over, ballInOver, timeoutSeconds: CARD_SELECT_TIMEOUT / 1000 });

        this.ballTimer = this.clock.setTimeout(() => {
            if (!this.batsmanCardId) {
                const bp = this.state.players.get(battingSid);
                this.batsmanCardId = bp?.battingCards?.[0]?.cardId || "default";
                this.startBall(battingSid, bowlingSid);
            }
        }, CARD_SELECT_TIMEOUT);

        // Bot auto-selects batsman card if it's the batsman
        if (this.isBot && battingSid === this.botSid) {
            this.clock.setTimeout(() => {
                if (this.batsmanCardId) return; // Already selected
                this.ballTimer?.clear();
                const bot = this.state.players.get(this.botSid);
                const cardIdx = Math.floor(Math.random() * (bot?.battingCards?.length || 1));
                this.batsmanCardId = bot?.battingCards?.[cardIdx]?.cardId || "bot_bat1";
                this.startBall(battingSid, bowlingSid);
            }, BOT_RESPONSE_DELAY);
        }
    }

    private handleSelectBatsman(client: Client, msg: { cardId: string }) {
        if (this.state.awaitingBowlerSelection) return;
        this.ballTimer?.clear();
        this.batsmanCardId = msg.cardId;
        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.startBall(bSid, wSid);
    }

    // Per-ball pattern data (stored for tap resolution)
    private currentPatternBoxes: PatternBox[] = [];

    private startBall(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        const bowlerCard  = this.state.players.get(bowlingSid)?.bowlingCards?.find((c: DeckCard) => c.cardId === this.bowlerCardId);
        const batsmanCard = this.state.players.get(battingSid)?.battingCards?.find((c: DeckCard) => c.cardId === this.batsmanCardId);
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

        // ── Generate pattern from seed ──
        const patternSeed = Date.now() ^ (ballNumber * 1000 + over * 100);
        const pattern = generatePattern(patternSeed, bowlerType, allPowerFlags);
        this.currentPatternBoxes = pattern.boxes;

        // Build activePowers array for client
        const activePowers = allPowerFlags.map(p => ({
            powerId: p, cardId: "", effectValue: 0,
        }));

        this.state.awaitingBatsmanTap = true;
        this.broadcast("ball_start", {
            ballNumber, over, ballInOver, arrowSpeed,
            timeoutSeconds: effectiveTimeout / 1000,
            bowlerCardId: this.bowlerCardId, bowlerType,
            // Pattern system fields
            patternSeed, patternName: pattern.name,
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
        }, effectiveTimeout);

        // Bot auto-taps if it's the batsman
        if (this.isBot && battingSid === this.botSid) {
            this.scheduleBotAction();
        }
    }

    private handleBatsmanTap(client: Client, msg: { position: number }) {
        if (!this.state.awaitingBatsmanTap) return;
        this.ballTimer?.clear();
        this.state.awaitingBatsmanTap = false;
        const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
        this.resolveBall(msg.position, bSid, wSid);
    }

    // ── Card Modifier: Zone Boundary Calculation ────────────────────────────

    /**
     * Computes dynamic zone boundaries based on batting vs bowling card strength.
     * Returns an array of cumulative boundary thresholds [0..1].
     * - Batting advantage → widens 4-run and 6-run zones, shrinks wicket zone
     * - Bowling advantage → widens wicket and dot zones, shrinks 4/6 zones
     */
    private computeZoneBoundaries(battingSid: string, bowlingSid: string): number[] {
        const batsmanCard = this.state.players.get(battingSid)?.battingCards
            ?.find((c: DeckCard) => c.cardId === this.batsmanCardId);
        const bowlerCard  = this.state.players.get(bowlingSid)?.bowlingCards
            ?.find((c: DeckCard) => c.cardId === this.bowlerCardId);

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

        // Clamp weights to minimum 0.2 (zones never vanish entirely)
        for (let i = 0; i < weights.length; i++) weights[i] = Math.max(0.2, weights[i]);

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

    private resolveBall(position: number, battingSid: string, bowlingSid: string) {
        const innings = this.activeInnings();

        // Resolve tap against pattern boxes if available, else fall back to zone boundaries
        let value: number;
        if (this.currentPatternBoxes.length > 0) {
            value = this.resolveAgainstPattern(position);
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

        innings.ballsBowled++;
        const overJustCompleted = innings.ballsBowled % this.state.ballsPerOver === 0;
        if (overJustCompleted) innings.currentOver++;

        const ball          = new BallState();
        ball.ballNumber     = innings.ballsBowled;
        ball.outcome        = outcome;
        ball.runs           = runs;
        ball.originalRuns   = originalRuns;
        ball.bowlerCardId   = this.bowlerCardId;
        ball.batsmanCardId  = this.batsmanCardId;
        ball.sliderPosition = Math.round(position * 100);
        ball.arrowSpeed     = this.state.currentBallArrowSpeed;
        ball.powerUsed      = powersApplied.join(",");
        innings.balls.push(ball);

        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingCards?.find((c: DeckCard) => c.cardId === this.bowlerCardId);
        const bowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        this.broadcast("ball_result", {
            ballNumber: ball.ballNumber, outcome, runs, originalRuns,
            score: innings.score, wickets: innings.wickets,
            ballsBowled: innings.ballsBowled, currentOver: innings.currentOver,
            bowlerType, powerUsed: ball.powerUsed, arrowSpeed: ball.arrowSpeed,
        });

        // ── Over completion broadcast ──
        if (overJustCompleted) {
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

        // Target chased — end innings
        const isChaseInnings = this.isSuperOver ? this.superOverInnings === 2 : this.currentInnings === 2;
        if (isChaseInnings && innings.target > 0 && innings.score >= innings.target) {
            this.endInnings(); return;
        }
        if (innings.ballsBowled >= maxBalls || innings.wickets >= maxWkts) {
            this.endInnings();
        } else {
            const nb = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
            const nw = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
            this.clock.setTimeout(() => this.promptBowlerCard(nb, nw), 1000);
        }
    }

    // ── Innings / Match End ──────────────────────────────────────────────────

    private endInnings() {
        if (this.isSuperOver) {
            this.endSuperOverInnings();
            return;
        }

        const innings = this.activeInnings();
        innings.isComplete = true;
        this.broadcast("innings_end", {
            inningsNumber: this.currentInnings, isSuperOver: false,
            score: innings.score, wickets: innings.wickets, ballsBowled: innings.ballsBowled,
        });

        if (this.currentInnings === 1) {
            this.state.phase = "innings_break";
            this.broadcast("innings_break", {
                innings1Score: innings.score, innings1Wickets: innings.wickets,
                innings1Balls: innings.ballsBowled, target: innings.score + 1, breakDuration: 5,
            });
            this.clock.setTimeout(() => this.startInnings(2), 5000);
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
        const isDraw = reason === "draw";
        const winnerRewards = winner ? {
            xpGained:       isDraw ? REWARD_XP_DRAW    : REWARD_XP_WIN,
            coinsGained:    isDraw ? REWARD_COIN_DRAW   : REWARD_COIN_WIN,
            gemsGained:     0,
            trophiesGained: isDraw ? REWARD_TROPHY_DRAW : REWARD_TROPHY_WIN,
            eloChange:      isDraw ? 0                  : eloDelta,
            cardRewards:    [] as string[],
        } : null;
        const loserRewards = loser ? {
            xpGained:       isDraw ? REWARD_XP_DRAW    : REWARD_XP_LOSS,
            coinsGained:    isDraw ? REWARD_COIN_DRAW   : REWARD_COIN_LOSS,
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
            const result   = isDraw ? "draw" : (isWinner ? "win" : (reason === "forfeit" || reason === "disconnect" ? reason : "loss"));
            const rewards  = isWinner ? winnerRewards : loserRewards;

            client.send("match_end", {
                result,
                winnerId:       winner?.playerId || "",
                winnerName:     winner?.name     || "",
                loserId:        loser?.playerId  || "",
                loserName:      loser?.name      || "",
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
    private handlePowerActivate(client: Client, msg: { powerId: string; cardId: string }) {
        const player = this.state.players.get(client.sessionId);
        if (!player) return;

        const powerType = msg.powerId;
        const config = POWER_CONFIGS[powerType];
        if (!config) {
            client.send("power_rejected", { powerId: powerType, reason: "unknown_power" });
            return;
        }

        // Only triggered powers can be manually activated
        if (config.activation !== "triggered") {
            client.send("power_rejected", { powerId: powerType, reason: "passive_power" });
            return;
        }

        // Must be in an active innings phase
        const phase = this.state.phase;
        if (!phase.startsWith("innings") && phase !== "super_over") {
            client.send("power_rejected", { powerId: powerType, reason: "wrong_phase" });
            return;
        }

        // Validate the player owns the card with this powerType
        const allCards = [...(player.battingCards || []), ...(player.bowlingCards || [])];
        const card = allCards.find((c: DeckCard) => c.cardId === msg.cardId && c.powerType === powerType);
        if (!card) {
            client.send("power_rejected", { powerId: powerType, reason: "card_not_found" });
            return;
        }

        // Check usage limit
        const usageKey = `${client.sessionId}:${powerType}`;
        const used = this.powerUsageCount.get(usageKey) || 0;
        if (used >= config.maxUsesPerMatch) {
            client.send("power_rejected", { powerId: powerType, reason: "max_uses_reached" });
            return;
        }

        // Check not already activated this ball
        if (this.activePowersThisBall.has(powerType + ":" + client.sessionId)) {
            client.send("power_rejected", { powerId: powerType, reason: "already_active" });
            return;
        }

        // Register activation
        this.powerUsageCount.set(usageKey, used + 1);
        this.activePowersThisBall.set(powerType + ":" + client.sessionId, {
            sid: client.sessionId, cardId: msg.cardId,
        });

        // Update synced state for client UI
        const slot = new PowerSlot();
        slot.playerId      = player.playerId;
        slot.powerId       = powerType;
        slot.cardId        = msg.cardId;
        slot.active        = true;
        slot.usesRemaining = config.maxUsesPerMatch - (used + 1);
        this.state.activePowers.push(slot);

        // Update PowerUsage map
        const pu = new PowerUsage();
        pu.powerId      = powerType;
        pu.cardId       = msg.cardId;
        pu.playerId     = player.playerId;
        pu.maxUses      = config.maxUsesPerMatch;
        pu.usesConsumed = used + 1;
        pu.activeThisBall = true;
        this.state.powerUsages.set(usageKey, pu);

        // Apply immediate effects (SpeedBoost modifies arrow speed before ball starts)
        if (powerType === "SpeedBoost") {
            this.state.currentBallArrowSpeed *= 1.5;
        }

        this.broadcast("power_applied", {
            playerId: player.playerId, powerId: powerType,
            cardId: msg.cardId, usesRemaining: slot.usesRemaining,
            effect: config.label,
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
        bot.name            = options.botName || "Cricket Bot";
        bot.elo             = options.elo     || 1000;
        bot.deckId          = "bot_deck";
        bot.connected       = true;
        this.state.players.set(this.botSid, bot);

        this.broadcast("player_joined", { playerId: bot.playerId, playerName: bot.name, elo: bot.elo });
        console.log(`[MatchRoom] Bot injected: ${bot.name} (elo=${bot.elo})`);

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

        const toCard = (c: any): DeckCard => {
            const card     = new DeckCard();
            card.cardId    = c.cardId;
            card.name      = c.name;
            card.role      = c.role;
            card.rarity    = c.rarity;
            card.powerType = c.powerType;
            card.basePower = c.basePower;
            card.level     = c.level;
            return card;
        };

        bot.deckId       = BOT_DECK.deckId;
        bot.battingCards  = new ArraySchema<DeckCard>(...BOT_DECK.battingCards.map(toCard));
        bot.bowlingCards   = new ArraySchema<DeckCard>(...BOT_DECK.bowlingCards.map(toCard));
        bot.ready         = true;

        this.deckReadyCount++;
        if (this.deckReadyCount >= 2) this.startInnings(1);
    }

    /**
     * Called by promptBowlerCard / promptBatsmanCard / startBall when
     * the active player is the bot. Schedules auto-responses.
     */
    private scheduleBotAction() {
        if (!this.isBot) return;

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
                    const cardIdx = Math.floor(Math.random() * (bot?.bowlingCards?.length || 1));
                    this.bowlerCardId = bot?.bowlingCards?.[cardIdx]?.cardId || "bot_bow1";
                    this.state.awaitingBowlerSelection = false;
                    const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
                    const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
                    this.promptBatsmanCard(bSid, wSid);
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
                    const bSid = this.currentInningsNum() === 1 ? this.battingSid : this.bowlingSid;
                    const wSid = this.currentInningsNum() === 1 ? this.bowlingSid : this.battingSid;
                    this.resolveBall(pos, bSid, wSid);
                }, BOT_RESPONSE_DELAY + Math.random() * 500);
            }
        }
    }
}
