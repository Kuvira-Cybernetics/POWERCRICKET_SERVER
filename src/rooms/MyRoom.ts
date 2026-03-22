import { Room, Client } from "colyseus";
import {
  MatchRoomState,
  PlayerState,
  InningsData,
  BallState,
  PowerSlot,
  PowerUsage,
  DeckCard,
} from "./schema/MyRoomState.js";
import { ArraySchema } from "@colyseus/schema";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

/** Card catalog entry (mirrors app.config.ts catalog) */
interface CardDef {
  cardId: string;
  name: string;
  role: string;
  rarity: string;
  powerType: string;
  basePower: number;
  description: string;
}

/** Triggered powers — must be manually activated */
const TRIGGERED_POWERS = [
  "Double Score",
  "Shield Wicket",
  "Speed Boost",
  "Time Freeze",
  "Ghost Ball",
  "Extra Life",
];

/** Passive powers — always active when card is in play */
const PASSIVE_POWERS = [
  "Colour Code",
  "Prediction Line",
  "Pressure Aura",
  "Steady Hand",
];

/** Max uses per triggered power per match (configurable) */
const POWER_MAX_USES: Record<string, number> = {
  "Double Score": 2,
  "Shield Wicket": 1,
  "Speed Boost": 2,
  "Time Freeze": 2,
  "Ghost Ball": 2,
  "Extra Life": 1,
};

/** Card role speed modifiers */
const ROLE_SPEED_MODIFIERS: Record<string, number> = {
  BowlingFast: 1.25,    // Fast bowlers increase arrow speed by 25%
  BowlingSpin: 0.85,    // Spin bowlers decrease arrow speed by 15%
  BattingStrategy: 0,   // Strategy gives +10% tap window (handled client-side)
  BattingDefense: -0.10, // Defense slows arrow speed by 10%
};

/** Catch probability base (server-controlled) */
const CATCH_PROBABILITY = 0.5;

/** Ball timeout in seconds */
const BALL_TIMEOUT_SECONDS = 10;

/** Heartbeat interval in ms */
const HEARTBEAT_INTERVAL = 5000;

/** Disconnect grace period in ms */
const DISCONNECT_GRACE_MS = 30000;

/** Reconnect timeout in seconds */
const RECONNECT_TIMEOUT_SECONDS = 30;

// ============================================================================
// ROOM IMPLEMENTATION
// ============================================================================

/**
 * MyRoom - Complete server-authoritative 1v1 cricket match room
 *
 * Features:
 * - Toss with random winner + bat/bowl choice
 * - Deck validation (2 batting + 2-3 bowling, min 1 Fast, max 2 Spin)
 * - Two complete innings with wicket/ball-based termination
 * - Bowling card selection per delivery
 * - Card role effects on arrow speed (Fast=faster, Spin=slower, Defense=slower)
 * - Power card activation with validation and usage limits
 * - Power effects on scoring (Double Score, Shield Wicket, etc.)
 * - Catch probability rolls
 * - Innings break phase
 * - Super Over on tie
 * - Disconnect handling with 30s reconnection grace period
 * - Heartbeat system
 * - Private rooms with room codes
 * - ELO calculation and differentiated rewards
 */
export class MyRoom extends Room {
  maxClients = 2;

  private clientMap = new Map<string, Client>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private ballTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = new Map<string, number>();

  /** Pending Shield Wicket activations for this ball (playerId → true) */
  private pendingShieldWicket = new Map<string, boolean>();

  /** Pending Extra Life activations window (playerId → expiry timestamp) */
  private extraLifeWindow = new Map<string, number>();

  get matchState(): MatchRoomState {
    return this.state as MatchRoomState;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  onCreate(options: any) {
    this.setState(new MatchRoomState());

    this.matchState.matchId = this.roomId;
    this.matchState.oversPerMatch = options?.oversPerMatch ?? 3;
    this.matchState.ballsPerOver = options?.ballsPerOver ?? 6;
    this.matchState.maxWickets = options?.maxWickets ?? 10;
    this.matchState.superOverEnabled = options?.superOverEnabled ?? true;
    this.matchState.phase = "lobby";

    // Private room setup
    if (options?.isPrivate) {
      this.matchState.isPrivate = true;
      this.matchState.roomCode = options.roomCode ?? this.generateRoomCode();
    }

    // Register all message handlers
    this.onMessage("toss_choice", (client, msg) => this.handleTossChoice(client, msg));
    this.onMessage("toss_bat_bowl", (client, msg) => this.handleTossBatBowl(client, msg));
    this.onMessage("deck_confirm", (client, msg) => this.handleDeckConfirm(client, msg));
    this.onMessage("select_bowler", (client, msg) => this.handleSelectBowler(client, msg));
    this.onMessage("select_batsman", (client, msg) => this.handleSelectBatsman(client, msg));
    this.onMessage("batsman_tap", (client, msg) => this.handleBatsmanTap(client, msg));
    this.onMessage("power_activate", (client, msg) => this.handlePowerActivate(client, msg));
    this.onMessage("forfeit", (client) => this.handleForfeit(client));
    this.onMessage("heartbeat", (client) => this.handleHeartbeat(client));

    // Start heartbeat checker
    this.startHeartbeatChecker();

    console.log(
      `[MyRoom ${this.roomId}] Created | overs=${this.matchState.oversPerMatch} ` +
        `private=${this.matchState.isPrivate} code=${this.matchState.roomCode}`
    );
  }

  onJoin(client: Client, options: any) {
    const playerState = new PlayerState();
    playerState.sessionId = client.sessionId;
    playerState.playerId = options?.playerId ?? client.sessionId;
    playerState.name = options?.playerName ?? `Player_${client.sessionId.slice(0, 6)}`;
    playerState.elo = options?.elo ?? 1000;
    playerState.deckId = options?.deckId ?? "";
    playerState.connected = true;
    playerState.ready = false;

    this.matchState.players.set(client.sessionId, playerState);
    this.clientMap.set(client.sessionId, client);
    this.lastHeartbeat.set(client.sessionId, Date.now());

    // Clear any existing disconnect timer (reconnection)
    if (this.disconnectTimers.has(client.sessionId)) {
      clearTimeout(this.disconnectTimers.get(client.sessionId)!);
      this.disconnectTimers.delete(client.sessionId);
    }

    console.log(
      `[MyRoom ${this.roomId}] ${playerState.name} (${client.sessionId}) joined. ` +
        `Players: ${this.matchState.players.size}/2`
    );

    this.broadcast("player_joined", {
      playerId: playerState.playerId,
      playerName: playerState.name,
      elo: playerState.elo,
    });

    // Start toss when both players are present
    if (this.matchState.players.size === 2) {
      this.clock.setTimeout(() => this.startToss(), 500);
    }
  }

  async onLeave(client: Client, code?: number) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;

    player.connected = false;

    // Code >= 4000 or 4000 = consented leave
    const consented = code !== undefined && code >= 4000;

    if (consented || this.matchState.phase === "result") {
      // Intentional leave or match already over
      console.log(
        `[MyRoom ${this.roomId}] ${player.name} left (code=${code}, consented=${consented})`
      );
      if (this.matchState.phase !== "result") {
        this.handleForfeit(client);
      }
    } else {
      // Unexpected disconnect — allow reconnection within grace period
      console.log(
        `[MyRoom ${this.roomId}] ${player.name} disconnected. ` +
          `Allowing reconnection for ${RECONNECT_TIMEOUT_SECONDS}s`
      );

      this.broadcast("player_disconnected", {
        playerId: player.playerId,
        graceSeconds: RECONNECT_TIMEOUT_SECONDS,
      });

      try {
        await this.allowReconnection(client, RECONNECT_TIMEOUT_SECONDS);
        // Player reconnected
        player.connected = true;
        this.clientMap.set(client.sessionId, client);
        this.lastHeartbeat.set(client.sessionId, Date.now());

        console.log(`[MyRoom ${this.roomId}] ${player.name} reconnected`);

        this.broadcast("player_reconnected", {
          playerId: player.playerId,
        });

        // If it was this player's turn, re-send the current ball state
        this.resendCurrentState(client);
      } catch (e) {
        // Reconnection timed out → forfeit
        console.log(
          `[MyRoom ${this.roomId}] Reconnection timeout for ${player.name}. Auto-forfeit.`
        );
        this.endMatchByDisconnect(player.playerId);
      }
    }
  }

  onDispose() {
    this.disconnectTimers.forEach((timer) => clearTimeout(timer));
    this.disconnectTimers.clear();
    if (this.ballTimeoutTimer) clearTimeout(this.ballTimeoutTimer);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    console.log(`[MyRoom ${this.roomId}] Disposed`);
  }

  // ==========================================================================
  // HEARTBEAT
  // ==========================================================================

  private startHeartbeatChecker() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, lastTime] of this.lastHeartbeat.entries()) {
        const player = this.matchState.players.get(sessionId) as PlayerState;
        if (!player || !player.connected) continue;

        // 3 missed heartbeats = potential disconnect
        if (now - lastTime > HEARTBEAT_INTERVAL * 3) {
          console.log(
            `[MyRoom ${this.roomId}] Heartbeat timeout for ${player.name}`
          );
          // Let Colyseus handle the actual disconnect via onLeave
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  private handleHeartbeat(client: Client) {
    this.lastHeartbeat.set(client.sessionId, Date.now());
    client.send("heartbeat_ack", { timestamp: Date.now() });
  }

  // ==========================================================================
  // TOSS
  // ==========================================================================

  private startToss() {
    if (this.matchState.players.size < 2) return;
    this.matchState.phase = "toss";

    // Randomly select one player to call the toss
    const playerIds = Array.from(this.matchState.players.values());
    const callerIndex = Math.random() < 0.5 ? 0 : 1;
    const caller = playerIds[callerIndex];
    this.matchState.tossCaller = caller.playerId;

    console.log(`[MyRoom ${this.roomId}] Toss: ${caller.name} to call`);

    this.broadcast("toss_screen", {
      callerId: caller.playerId,
      callerName: caller.name,
      timeoutSeconds: 15,
    });

    // Auto-assign if no choice in 15s
    this.clock.setTimeout(() => {
      if (this.matchState.phase === "toss") {
        console.log(`[MyRoom ${this.roomId}] Toss timeout — auto-calling heads`);
        this.resolveTossFlip(caller.playerId, "heads");
      }
    }, 15000);
  }

  private handleTossChoice(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;
    if (this.matchState.phase !== "toss") return;

    // Only the designated caller can call the toss
    if (player.playerId !== this.matchState.tossCaller) {
      client.send("error", { message: "You are not the toss caller" });
      return;
    }

    const choice = message.choice?.toLowerCase();
    if (!["heads", "tails"].includes(choice)) {
      client.send("error", { message: "Invalid toss choice. Use heads or tails." });
      return;
    }

    this.resolveTossFlip(player.playerId, choice);
  }

  private resolveTossFlip(callerId: string, callerCall: string) {
    // Server decides coin flip
    const coinResult = Math.random() < 0.5 ? "heads" : "tails";
    const callerWon = coinResult === callerCall;

    const winnerId = callerWon
      ? callerId
      : this.getOpponentPlayerId(callerId) ?? callerId;

    this.matchState.tossWinner = winnerId;
    this.matchState.phase = "toss_choice";

    const winner = this.getPlayerByPlayerId(winnerId);

    console.log(
      `[MyRoom ${this.roomId}] Coin: ${coinResult}. Call: ${callerCall}. ` +
        `Winner: ${winner?.name}. Awaiting bat/bowl choice.`
    );

    this.broadcast("toss_result", {
      coinResult,
      callerCall,
      winnerId,
      winnerName: winner?.name,
      message: `${winner?.name} won the toss! Choose to bat or bowl.`,
    });

    // Auto-choose bat if no response in 10s
    this.clock.setTimeout(() => {
      if (this.matchState.phase === "toss_choice") {
        console.log(`[MyRoom ${this.roomId}] Bat/bowl choice timeout — auto-choosing bat`);
        this.resolveTossBatBowl(winnerId, "bat");
      }
    }, 10000);
  }

  private handleTossBatBowl(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;
    if (this.matchState.phase !== "toss_choice") return;

    if (player.playerId !== this.matchState.tossWinner) {
      client.send("error", { message: "Only the toss winner can choose bat/bowl" });
      return;
    }

    const choice = message.choice?.toLowerCase();
    if (!["bat", "bowl"].includes(choice)) {
      client.send("error", { message: "Invalid choice. Use bat or bowl." });
      return;
    }

    this.resolveTossBatBowl(player.playerId, choice);
  }

  private resolveTossBatBowl(winnerId: string, choice: string) {
    this.matchState.tossChoice = choice;
    this.matchState.phase = "deck_confirm";

    // Assign batting/bowling for innings 1
    const opponentId = this.getOpponentPlayerId(winnerId) ?? "";
    if (choice === "bat") {
      this.matchState.innings1.battingPlayerId = winnerId;
      this.matchState.innings1.bowlingPlayerId = opponentId;
    } else {
      this.matchState.innings1.battingPlayerId = opponentId;
      this.matchState.innings1.bowlingPlayerId = winnerId;
    }

    const winner = this.getPlayerByPlayerId(winnerId);

    console.log(
      `[MyRoom ${this.roomId}] ${winner?.name} chose to ${choice}. ` +
        `Batting: ${this.matchState.innings1.battingPlayerId}, ` +
        `Bowling: ${this.matchState.innings1.bowlingPlayerId}`
    );

    this.broadcast("toss_decision", {
      winnerId,
      winnerName: winner?.name,
      choice,
      battingPlayerId: this.matchState.innings1.battingPlayerId,
      bowlingPlayerId: this.matchState.innings1.bowlingPlayerId,
    });
  }

  // ==========================================================================
  // DECK CONFIRM & VALIDATION
  // ==========================================================================

  private handleDeckConfirm(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;
    if (this.matchState.phase !== "deck_confirm") return;

    const battingCards: any[] = message.battingCards ?? [];
    const bowlingCards: any[] = message.bowlingCards ?? [];

    // Validate deck composition
    const validation = this.validateDeck(battingCards, bowlingCards);
    if (!validation.valid) {
      client.send("deck_invalid", {
        error: validation.error,
      });
      return;
    }

    // Store cards on player state
    player.battingCards = new ArraySchema<DeckCard>();
    for (const card of battingCards) {
      const dc = new DeckCard();
      dc.cardId = card.cardId ?? "";
      dc.name = card.name ?? "";
      dc.role = card.role ?? "";
      dc.rarity = card.rarity ?? "Common";
      dc.powerType = card.powerType ?? "";
      dc.basePower = card.basePower ?? 1.0;
      dc.level = card.level ?? 1;
      player.battingCards.push(dc);
    }

    player.bowlingCards = new ArraySchema<DeckCard>();
    for (const card of bowlingCards) {
      const dc = new DeckCard();
      dc.cardId = card.cardId ?? "";
      dc.name = card.name ?? "";
      dc.role = card.role ?? "";
      dc.rarity = card.rarity ?? "Common";
      dc.powerType = card.powerType ?? "";
      dc.basePower = card.basePower ?? 1.0;
      dc.level = card.level ?? 1;
      player.bowlingCards.push(dc);
    }

    // Initialize power usages for triggered powers
    this.initializePowerUsages(player);

    player.ready = true;
    player.deckId = message.deckId ?? player.deckId;

    console.log(
      `[MyRoom ${this.roomId}] ${player.name} confirmed deck ` +
        `(${battingCards.length} batting, ${bowlingCards.length} bowling)`
    );

    // Check if both players are ready
    const allReady = Array.from(this.matchState.players.values()).every(
      (p: PlayerState) => p.ready
    );
    if (allReady) {
      this.clock.setTimeout(() => this.beginInnings(1), 1000);
    }
  }

  private validateDeck(
    battingCards: any[],
    bowlingCards: any[]
  ): { valid: boolean; error?: string } {
    // Must have exactly 2 batting cards
    if (battingCards.length !== 2) {
      return { valid: false, error: "Deck must contain exactly 2 batting cards" };
    }

    // Must have 2-3 bowling cards
    if (bowlingCards.length < 2 || bowlingCards.length > 3) {
      return { valid: false, error: "Deck must contain 2-3 bowling cards" };
    }

    // Validate batting card roles
    for (const card of battingCards) {
      if (!["BattingStrategy", "BattingDefense"].includes(card.role)) {
        return { valid: false, error: `Invalid batting card role: ${card.role}` };
      }
    }

    // Validate bowling card roles and composition
    let fastCount = 0;
    let spinCount = 0;
    for (const card of bowlingCards) {
      if (card.role === "BowlingFast") fastCount++;
      else if (card.role === "BowlingSpin") spinCount++;
      else return { valid: false, error: `Invalid bowling card role: ${card.role}` };
    }

    if (fastCount < 1) {
      return { valid: false, error: "Deck must contain at least 1 Fast bowler" };
    }
    if (spinCount > 2) {
      return { valid: false, error: "Deck cannot contain more than 2 Spin bowlers" };
    }

    return { valid: true };
  }

  private initializePowerUsages(player: PlayerState) {
    const allCards = [
      ...Array.from(player.battingCards),
      ...Array.from(player.bowlingCards),
    ];

    for (const card of allCards) {
      if (TRIGGERED_POWERS.includes(card.powerType)) {
        const key = `${player.playerId}_${card.cardId}_${card.powerType}`;
        const usage = new PowerUsage();
        usage.powerId = card.powerType;
        usage.cardId = card.cardId;
        usage.playerId = player.playerId;
        usage.maxUses = POWER_MAX_USES[card.powerType] ?? 1;
        usage.usesConsumed = 0;
        usage.activeThisBall = false;
        this.matchState.powerUsages.set(key, usage);
      }
    }
  }

  // ==========================================================================
  // INNINGS FLOW
  // ==========================================================================

  private beginInnings(inningsNumber: number) {
    const isSuperOver = inningsNumber > 2;
    let innings: InningsData;

    if (isSuperOver) {
      innings =
        inningsNumber === 3
          ? this.matchState.superOverInnings1
          : this.matchState.superOverInnings2;
    } else {
      innings =
        inningsNumber === 1
          ? this.matchState.innings1
          : this.matchState.innings2;
    }

    // In innings 2, swap roles
    if (inningsNumber === 2) {
      innings.battingPlayerId = this.matchState.innings1.bowlingPlayerId;
      innings.bowlingPlayerId = this.matchState.innings1.battingPlayerId;
      innings.target = this.matchState.innings1.score + 1;
    }

    // Super Over innings 1: team that batted second in main match bats first
    if (inningsNumber === 3) {
      innings.battingPlayerId = this.matchState.innings2.battingPlayerId;
      innings.bowlingPlayerId = this.matchState.innings2.bowlingPlayerId;
    }

    // Super Over innings 2: swap
    if (inningsNumber === 4) {
      innings.battingPlayerId = this.matchState.superOverInnings1.bowlingPlayerId;
      innings.bowlingPlayerId = this.matchState.superOverInnings1.battingPlayerId;
      innings.target = this.matchState.superOverInnings1.score + 1;
    }

    innings.score = 0;
    innings.wickets = 0;
    innings.ballsBowled = 0;
    innings.currentOver = 0;
    innings.isComplete = false;
    innings.balls = new ArraySchema<BallState>();

    // Set phase
    if (isSuperOver) {
      this.matchState.phase = inningsNumber === 3 ? "super_over_1" : "super_over_2";
    } else {
      this.matchState.phase = inningsNumber === 1 ? "innings1" : "innings2";
    }

    console.log(
      `[MyRoom ${this.roomId}] Begin ${isSuperOver ? "Super Over " : ""}Innings ${isSuperOver ? inningsNumber - 2 : inningsNumber}: ` +
        `${this.getPlayerByPlayerId(innings.battingPlayerId)?.name} (bat) vs ` +
        `${this.getPlayerByPlayerId(innings.bowlingPlayerId)?.name} (bowl)` +
        `${innings.target >= 0 ? ` | Target: ${innings.target}` : ""}`
    );

    this.broadcast("innings_start", {
      inningsNumber: isSuperOver ? inningsNumber - 2 : inningsNumber,
      isSuperOver,
      battingPlayerId: innings.battingPlayerId,
      bowlingPlayerId: innings.bowlingPlayerId,
      target: innings.target,
      oversPerInnings: isSuperOver ? 1 : this.matchState.oversPerMatch,
    });

    // Begin first ball — request bowler selection
    this.clock.setTimeout(() => this.requestBowlerSelection(), 1500);
  }

  private startInningsBreak() {
    this.matchState.phase = "innings_break";
    const score = this.matchState.innings1.score;
    const wickets = this.matchState.innings1.wickets;
    const target = score + 1;

    console.log(
      `[MyRoom ${this.roomId}] Innings Break. Innings 1: ${score}/${wickets}. Target: ${target}`
    );

    this.broadcast("innings_break", {
      innings1Score: score,
      innings1Wickets: wickets,
      innings1Balls: this.matchState.innings1.ballsBowled,
      target,
      breakDuration: 10,
    });

    // Auto-start innings 2 after break
    this.clock.setTimeout(() => {
      // Reset player ready states for innings 2
      for (const player of this.matchState.players.values()) {
        (player as PlayerState).ready = true; // Auto-ready for innings 2
      }
      this.beginInnings(2);
    }, 10000);
  }

  // ==========================================================================
  // BOWLING CARD SELECTION
  // ==========================================================================

  private requestBowlerSelection() {
    const innings = this.getCurrentInnings();
    if (!innings || innings.isComplete) return;

    this.matchState.awaitingBowlerSelection = true;
    this.matchState.awaitingBatsmanTap = false;

    const ballNumber = innings.ballsBowled + 1;
    const over = Math.floor((ballNumber - 1) / this.matchState.ballsPerOver);
    const ballInOver = ((ballNumber - 1) % this.matchState.ballsPerOver) + 1;

    // Send to bowling player only
    const bowlerClient = this.getClientByPlayerId(innings.bowlingPlayerId);
    if (bowlerClient) {
      bowlerClient.send("select_bowler_card", {
        ballNumber,
        over,
        ballInOver,
        timeoutSeconds: BALL_TIMEOUT_SECONDS,
      });
    }

    // Also notify batsman to select active batsman card
    const batsmanClient = this.getClientByPlayerId(innings.battingPlayerId);
    if (batsmanClient) {
      batsmanClient.send("select_batsman_card", {
        ballNumber,
        over,
        ballInOver,
        timeoutSeconds: BALL_TIMEOUT_SECONDS,
      });
    }

    // Timeout: auto-select first bowling card
    this.ballTimeoutTimer = setTimeout(() => {
      if (this.matchState.awaitingBowlerSelection) {
        this.autoSelectBowler(innings);
      }
    }, BALL_TIMEOUT_SECONDS * 1000);
  }

  private handleSelectBowler(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;

    const innings = this.getCurrentInnings();
    if (!innings) return;

    if (innings.bowlingPlayerId !== player.playerId) {
      client.send("error", { message: "You are not the bowler" });
      return;
    }

    if (!this.matchState.awaitingBowlerSelection) {
      client.send("error", { message: "Not awaiting bowler selection" });
      return;
    }

    const cardId = message.cardId ?? "";
    // Validate card is in player's bowling cards
    const card = Array.from(player.bowlingCards).find(
      (c: DeckCard) => c.cardId === cardId
    );

    if (!card) {
      client.send("error", { message: "Card not in your bowling deck" });
      return;
    }

    player.activeBowlerCardId = cardId;
    this.matchState.awaitingBowlerSelection = false;
    if (this.ballTimeoutTimer) {
      clearTimeout(this.ballTimeoutTimer);
      this.ballTimeoutTimer = null;
    }

    console.log(
      `[MyRoom ${this.roomId}] ${player.name} selected bowler: ${card.name} (${card.role})`
    );

    this.deliverBall();
  }

  private handleSelectBatsman(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;

    const innings = this.getCurrentInnings();
    if (!innings) return;

    if (innings.battingPlayerId !== player.playerId) {
      client.send("error", { message: "You are not the batsman" });
      return;
    }

    const cardId = message.cardId ?? "";
    const card = Array.from(player.battingCards).find(
      (c: DeckCard) => c.cardId === cardId
    );

    if (!card) {
      client.send("error", { message: "Card not in your batting deck" });
      return;
    }

    player.activeBatsmanCardId = cardId;
    console.log(
      `[MyRoom ${this.roomId}] ${player.name} selected batsman: ${card.name} (${card.role})`
    );
  }

  private autoSelectBowler(innings: InningsData) {
    const bowler = this.getPlayerByPlayerId(innings.bowlingPlayerId);
    if (!bowler) return;

    // Auto-select first bowling card
    if (bowler.bowlingCards.length > 0) {
      const firstCard = bowler.bowlingCards[0] as DeckCard;
      bowler.activeBowlerCardId = firstCard.cardId;
      console.log(
        `[MyRoom ${this.roomId}] Auto-selected bowler card: ${firstCard.name}`
      );
    }

    this.matchState.awaitingBowlerSelection = false;
    this.deliverBall();
  }

  // ==========================================================================
  // BALL DELIVERY & RESOLUTION
  // ==========================================================================

  private deliverBall() {
    const innings = this.getCurrentInnings();
    if (!innings || innings.isComplete) return;

    const ballNumber = innings.ballsBowled + 1;
    const over = Math.floor((ballNumber - 1) / this.getBallsPerInnings());
    const ballInOver = ((ballNumber - 1) % this.matchState.ballsPerOver) + 1;

    // Calculate arrow speed based on bowler and batsman card roles
    const arrowSpeed = this.calculateArrowSpeed(innings);
    this.matchState.currentBallArrowSpeed = arrowSpeed;
    this.matchState.awaitingBatsmanTap = true;

    // Clear any pending power activations from previous ball
    this.clearBallPowerState();

    // Check for passive powers
    const passiveEffects = this.getPassiveEffects(innings);

    console.log(
      `[MyRoom ${this.roomId}] Ball ${ballNumber} (Over ${over + 1}.${ballInOver}) | ` +
        `Speed: ${arrowSpeed.toFixed(2)} | Passives: ${passiveEffects.join(", ") || "none"}`
    );

    this.broadcast("ball_start", {
      ballNumber,
      over: over + 1,
      ballInOver,
      arrowSpeed,
      timeoutSeconds: BALL_TIMEOUT_SECONDS,
      bowlerCardId: this.getBowlerPlayer(innings)?.activeBowlerCardId ?? "",
      bowlerType: this.getBowlerCardRole(innings),
      passiveEffects,
    });

    // Timeout: auto-tap at 0.5 (middle) if batsman doesn't respond
    this.ballTimeoutTimer = setTimeout(() => {
      if (this.matchState.awaitingBatsmanTap) {
        console.log(`[MyRoom ${this.roomId}] Ball timeout — auto-tap at 0.5`);
        const batter = this.getPlayerByPlayerId(innings.battingPlayerId);
        if (batter) {
          this.resolveBall(0.5, batter.playerId);
        }
      }
    }, BALL_TIMEOUT_SECONDS * 1000);
  }

  private calculateArrowSpeed(innings: InningsData): number {
    let speed = 1.0; // base speed

    // Bowler card role effect
    const bowlerPlayer = this.getBowlerPlayer(innings);
    if (bowlerPlayer?.activeBowlerCardId) {
      const bowlerCard = Array.from(bowlerPlayer.bowlingCards).find(
        (c: DeckCard) => c.cardId === bowlerPlayer.activeBowlerCardId
      );
      if (bowlerCard) {
        const modifier = ROLE_SPEED_MODIFIERS[bowlerCard.role] ?? 0;
        if (bowlerCard.role === "BowlingFast") speed *= modifier;
        else if (bowlerCard.role === "BowlingSpin") speed *= modifier;
      }
    }

    // Batsman card role effect (Defense slows arrow)
    const batsmanPlayer = this.getBatterPlayer(innings);
    if (batsmanPlayer?.activeBatsmanCardId) {
      const batsmanCard = Array.from(batsmanPlayer.battingCards).find(
        (c: DeckCard) => c.cardId === batsmanPlayer.activeBatsmanCardId
      );
      if (batsmanCard && batsmanCard.role === "BattingDefense") {
        speed += ROLE_SPEED_MODIFIERS["BattingDefense"]; // -0.10
      }
    }

    // Clamp speed between 0.5 and 2.0
    return Math.max(0.5, Math.min(2.0, speed));
  }

  private getPassiveEffects(innings: InningsData): string[] {
    const effects: string[] = [];
    const batter = this.getBatterPlayer(innings);
    const bowler = this.getBowlerPlayer(innings);

    if (batter?.activeBatsmanCardId) {
      const card = Array.from(batter.battingCards).find(
        (c: DeckCard) => c.cardId === batter.activeBatsmanCardId
      );
      if (card && PASSIVE_POWERS.includes(card.powerType)) {
        effects.push(card.powerType);
      }
    }

    if (bowler?.activeBowlerCardId) {
      const card = Array.from(bowler.bowlingCards).find(
        (c: DeckCard) => c.cardId === bowler.activeBowlerCardId
      );
      if (card && PASSIVE_POWERS.includes(card.powerType)) {
        effects.push(card.powerType);
      }
    }

    return effects;
  }

  private handleBatsmanTap(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;

    const innings = this.getCurrentInnings();
    if (!innings) return;

    if (innings.battingPlayerId !== player.playerId) {
      client.send("error", { message: "You are not the batsman" });
      return;
    }

    if (!this.matchState.awaitingBatsmanTap) {
      client.send("error", { message: "Not awaiting batsman tap" });
      return;
    }

    if (this.ballTimeoutTimer) {
      clearTimeout(this.ballTimeoutTimer);
      this.ballTimeoutTimer = null;
    }

    const tapPosition = message.position ?? 0.5;
    this.resolveBall(tapPosition, player.playerId);
  }

  private resolveBall(tapPosition: number, battingPlayerId: string) {
    const innings = this.getCurrentInnings();
    if (!innings || innings.battingPlayerId !== battingPlayerId) return;

    this.matchState.awaitingBatsmanTap = false;
    const normalizedPos = Math.max(0, Math.min(1, tapPosition));

    // Determine base outcome from slider zones
    let outcome = "dot";
    let runs = 0;
    const sliderResult = this.getSliderOutcome(normalizedPos);
    outcome = sliderResult.outcome;
    runs = sliderResult.runs;

    // Check for catch outcome (between wicket zones)
    if (outcome === "catch") {
      const catchRoll = Math.random();
      if (catchRoll < CATCH_PROBABILITY) {
        outcome = "wicket";
        runs = 0;
      } else {
        outcome = "catch_dropped";
        runs = sliderResult.runs; // runs from the zone if dropped
      }
    }

    const originalRuns = runs;

    // Apply active power effects
    const powerResult = this.applyPowerEffects(
      innings,
      outcome,
      runs,
      battingPlayerId
    );
    outcome = powerResult.outcome;
    runs = powerResult.runs;

    // Record ball
    const ball = new BallState();
    ball.ballNumber = innings.ballsBowled + 1;
    ball.sliderPosition = Math.round(normalizedPos * 100);
    ball.outcome = outcome;
    ball.runs = outcome === "wicket" ? 0 : runs;
    ball.originalRuns = originalRuns;
    ball.bowlerType = this.getBowlerCardRole(innings);
    ball.bowlerCardId = this.getBowlerPlayer(innings)?.activeBowlerCardId ?? "";
    ball.batsmanCardId = this.getBatterPlayer(innings)?.activeBatsmanCardId ?? "";
    ball.powerUsed = powerResult.powerUsed;
    ball.arrowSpeed = this.matchState.currentBallArrowSpeed;

    innings.balls.push(ball);
    innings.ballsBowled += 1;

    // Update score/wickets
    if (outcome === "wicket") {
      innings.wickets += 1;
      // Open Extra Life window (3 seconds)
      this.extraLifeWindow.set(battingPlayerId, Date.now() + 3000);
    } else {
      innings.score += runs;
    }

    innings.currentOver = Math.floor(
      innings.ballsBowled / this.matchState.ballsPerOver
    );

    console.log(
      `[MyRoom ${this.roomId}] Ball ${ball.ballNumber}: ${outcome} ` +
        `${runs > 0 ? `(${runs} runs)` : ""} | ` +
        `Score: ${innings.score}/${innings.wickets}` +
        `${powerResult.powerUsed ? ` | Power: ${powerResult.powerUsed}` : ""}`
    );

    this.broadcast("ball_result", {
      ballNumber: ball.ballNumber,
      outcome,
      runs: ball.runs,
      originalRuns,
      score: innings.score,
      wickets: innings.wickets,
      ballsBowled: innings.ballsBowled,
      currentOver: innings.currentOver,
      bowlerType: ball.bowlerType,
      powerUsed: powerResult.powerUsed,
      arrowSpeed: ball.arrowSpeed,
    });

    // Check innings end
    if (this.checkInningsEnd(innings)) {
      this.clock.setTimeout(
        () => this.endInnings(this.getInningsNumber()),
        2000
      );
    } else {
      // Next ball — request bowler selection
      this.clock.setTimeout(() => this.requestBowlerSelection(), 2000);
    }
  }

  private getSliderOutcome(pos: number): {
    outcome: string;
    runs: number;
  } {
    // Slider zones based on GameMechanics.md:
    // [W][0][1][2][3][4][6][W] with catch zones near boundaries
    if (pos < 0.05) return { outcome: "wicket", runs: 0 };
    if (pos < 0.10) return { outcome: "catch", runs: 0 };
    if (pos < 0.20) return { outcome: "dot", runs: 0 };
    if (pos < 0.35) return { outcome: "run", runs: 1 };
    if (pos < 0.50) return { outcome: "run", runs: 2 };
    if (pos < 0.65) return { outcome: "run", runs: 3 };
    if (pos < 0.80) return { outcome: "run", runs: 4 };
    if (pos < 0.90) return { outcome: "run", runs: 6 };
    if (pos < 0.95) return { outcome: "catch", runs: 0 };
    return { outcome: "wicket", runs: 0 };
  }

  // ==========================================================================
  // POWER CARD SYSTEM
  // ==========================================================================

  private handlePowerActivate(client: Client, message: any) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player) return;

    const powerId: string = message.powerId ?? "";
    const cardId: string = message.cardId ?? "";

    if (!powerId || !cardId) {
      client.send("error", { message: "Invalid power activation: missing powerId or cardId" });
      return;
    }

    // Validate it's a triggered power
    if (!TRIGGERED_POWERS.includes(powerId)) {
      client.send("error", { message: `${powerId} is a passive power and cannot be triggered` });
      return;
    }

    // Check usage limits
    const usageKey = `${player.playerId}_${cardId}_${powerId}`;
    const usage = this.matchState.powerUsages.get(usageKey) as PowerUsage;

    if (!usage) {
      client.send("error", { message: "Power not available in your deck" });
      return;
    }

    if (usage.usesConsumed >= usage.maxUses) {
      client.send("error", { message: `${powerId} has no uses remaining (${usage.usesConsumed}/${usage.maxUses})` });
      return;
    }

    // Special validation for Extra Life — must be within wicket window
    if (powerId === "Extra Life") {
      const window = this.extraLifeWindow.get(player.playerId);
      if (!window || Date.now() > window) {
        client.send("error", {
          message: "Extra Life can only be used immediately after a wicket",
        });
        return;
      }
      // Apply Extra Life: undo last wicket
      this.applyExtraLife(player.playerId);
      usage.usesConsumed += 1;
      this.extraLifeWindow.delete(player.playerId);

      this.broadcast("power_applied", {
        playerId: player.playerId,
        powerId,
        cardId,
        effect: "Wicket reversed by Extra Life",
      });
      return;
    }

    // Mark power as active for this ball
    usage.usesConsumed += 1;
    usage.activeThisBall = true;

    // Special handling for Shield Wicket — record pending
    if (powerId === "Shield Wicket") {
      this.pendingShieldWicket.set(player.playerId, true);
    }

    // Record in activePowers for state sync
    const slot = new PowerSlot();
    slot.playerId = player.playerId;
    slot.powerId = powerId;
    slot.cardId = cardId;
    slot.active = true;
    slot.usesRemaining = usage.maxUses - usage.usesConsumed;
    this.matchState.activePowers.push(slot);

    console.log(
      `[MyRoom ${this.roomId}] ${player.name} activated ${powerId} ` +
        `(${usage.usesConsumed}/${usage.maxUses} used)`
    );

    this.broadcast("power_applied", {
      playerId: player.playerId,
      powerId,
      cardId,
      usesRemaining: usage.maxUses - usage.usesConsumed,
    });
  }

  private applyPowerEffects(
    innings: InningsData,
    outcome: string,
    runs: number,
    battingPlayerId: string
  ): { outcome: string; runs: number; powerUsed: string } {
    let powerUsed = "";
    const bowlingPlayerId = innings.bowlingPlayerId;

    // Check Shield Wicket (batting power — converts wicket to dot)
    if (outcome === "wicket" && this.pendingShieldWicket.has(battingPlayerId)) {
      outcome = "dot";
      runs = 0;
      powerUsed = "Shield Wicket";
      this.pendingShieldWicket.delete(battingPlayerId);
    }

    // Check Double Score (batting power — doubles runs)
    const doubleScoreKey = this.findActivePower(battingPlayerId, "Double Score");
    if (doubleScoreKey && runs > 0) {
      runs *= 2;
      powerUsed = powerUsed ? `${powerUsed}+Double Score` : "Double Score";
      this.deactivateBallPower(doubleScoreKey);
    }

    // Speed Boost is applied during arrow speed calculation (bowling power)
    // Time Freeze is handled client-side (pause arrow for 1s)
    // Ghost Ball is handled client-side (hide pattern values)

    // Check Pressure Aura (passive — reduces opponent timing window, handled client-side)
    // Check Steady Hand (passive — reduces arrow wobble, handled client-side)

    return { outcome, runs, powerUsed };
  }

  private applyExtraLife(battingPlayerId: string) {
    const innings = this.getCurrentInnings();
    if (!innings) return;

    // Undo the last wicket
    if (innings.wickets > 0) {
      innings.wickets -= 1;
      console.log(
        `[MyRoom ${this.roomId}] Extra Life: wickets reduced to ${innings.wickets}`
      );
    }
  }

  private findActivePower(playerId: string, powerType: string): string | null {
    for (const [key, usage] of this.matchState.powerUsages.entries()) {
      const u = usage as PowerUsage;
      if (
        u.playerId === playerId &&
        u.powerId === powerType &&
        u.activeThisBall
      ) {
        return key;
      }
    }
    return null;
  }

  private deactivateBallPower(key: string) {
    const usage = this.matchState.powerUsages.get(key) as PowerUsage;
    if (usage) usage.activeThisBall = false;
  }

  private clearBallPowerState() {
    for (const usage of this.matchState.powerUsages.values()) {
      (usage as PowerUsage).activeThisBall = false;
    }
    this.pendingShieldWicket.clear();
  }

  // ==========================================================================
  // INNINGS END & MATCH END
  // ==========================================================================

  private checkInningsEnd(innings: InningsData): boolean {
    const totalBalls = this.getMaxBallsForInnings();

    // All out
    if (innings.wickets >= this.matchState.maxWickets) {
      console.log(`[MyRoom ${this.roomId}] Innings ended: All out (${innings.wickets} wickets)`);
      return true;
    }

    // Overs completed
    if (innings.ballsBowled >= totalBalls) {
      console.log(`[MyRoom ${this.roomId}] Innings ended: Overs completed`);
      return true;
    }

    // Innings 2 / Super Over 2: target exceeded
    if (
      innings.target >= 0 &&
      innings.score >= innings.target
    ) {
      console.log(
        `[MyRoom ${this.roomId}] Innings ended: Target met/exceeded ` +
          `(${innings.score} >= ${innings.target})`
      );
      return true;
    }

    return false;
  }

  private endInnings(inningsNumber: number) {
    const isSuperOver = inningsNumber > 2;
    let innings: InningsData;

    if (isSuperOver) {
      innings =
        inningsNumber === 3
          ? this.matchState.superOverInnings1
          : this.matchState.superOverInnings2;
    } else {
      innings =
        inningsNumber === 1
          ? this.matchState.innings1
          : this.matchState.innings2;
    }

    innings.isComplete = true;

    const batter = this.getPlayerByPlayerId(innings.battingPlayerId);
    console.log(
      `[MyRoom ${this.roomId}] ${isSuperOver ? "Super Over " : ""}Innings ${isSuperOver ? inningsNumber - 2 : inningsNumber} ended: ` +
        `${batter?.name}: ${innings.score}/${innings.wickets}`
    );

    this.broadcast("innings_end", {
      inningsNumber: isSuperOver ? inningsNumber - 2 : inningsNumber,
      isSuperOver,
      score: innings.score,
      wickets: innings.wickets,
      ballsBowled: innings.ballsBowled,
    });

    if (inningsNumber === 1) {
      // Go to innings break
      this.clock.setTimeout(() => this.startInningsBreak(), 2000);
    } else if (inningsNumber === 2) {
      // Check for tie → super over
      this.clock.setTimeout(() => this.resolveMainMatch(), 2000);
    } else if (inningsNumber === 3) {
      // Super over innings 1 done — start super over innings 2
      this.clock.setTimeout(() => this.beginInnings(4), 3000);
    } else if (inningsNumber === 4) {
      // Super over innings 2 done — resolve
      this.clock.setTimeout(() => this.resolveSuperOver(), 2000);
    }
  }

  private resolveMainMatch() {
    const score1 = this.matchState.innings1.score;
    const score2 = this.matchState.innings2.score;
    const wickets1 = this.matchState.innings1.wickets;
    const wickets2 = this.matchState.innings2.wickets;

    if (score1 !== score2) {
      // Clear winner
      this.endMatchNormal();
    } else {
      // Tied on score — compare wickets
      if (wickets1 !== wickets2) {
        // Fewer wickets wins
        this.endMatchNormal();
      } else if (this.matchState.superOverEnabled) {
        // Super Over
        console.log(
          `[MyRoom ${this.roomId}] Scores tied ${score1}-${score2}, ` +
            `wickets tied ${wickets1}-${wickets2}. Starting Super Over.`
        );
        this.broadcast("super_over_start", {
          reason: "Scores and wickets tied",
          innings1Score: score1,
          innings2Score: score2,
        });
        this.clock.setTimeout(() => this.beginInnings(3), 3000);
      } else {
        // Draw
        this.endMatchDraw();
      }
    }
  }

  private resolveSuperOver() {
    const so1Score = this.matchState.superOverInnings1.score;
    const so2Score = this.matchState.superOverInnings2.score;
    const so1Wickets = this.matchState.superOverInnings1.wickets;
    const so2Wickets = this.matchState.superOverInnings2.wickets;

    if (so1Score !== so2Score) {
      // Winner determined by super over scores
      const winnerId =
        so2Score > so1Score
          ? this.matchState.superOverInnings2.battingPlayerId
          : this.matchState.superOverInnings1.battingPlayerId;

      this.endMatchWithWinner(winnerId, "super_over");
    } else if (so1Wickets !== so2Wickets) {
      // Fewer wickets in super over wins
      const winnerId =
        so2Wickets < so1Wickets
          ? this.matchState.superOverInnings2.battingPlayerId
          : this.matchState.superOverInnings1.battingPlayerId;

      this.endMatchWithWinner(winnerId, "super_over");
    } else {
      // Super Over also tied — draw
      this.endMatchDraw();
    }
  }

  private endMatchNormal() {
    const score1 = this.matchState.innings1.score;
    const score2 = this.matchState.innings2.score;
    const wickets1 = this.matchState.innings1.wickets;
    const wickets2 = this.matchState.innings2.wickets;

    let winnerId = "";
    let winReason = "";

    if (score2 > score1) {
      winnerId = this.matchState.innings2.battingPlayerId;
      winReason = "chase";
    } else if (score1 > score2) {
      winnerId = this.matchState.innings1.battingPlayerId;
      winReason = "defended";
    } else {
      // Tied on score — fewer wickets wins
      if (wickets2 < wickets1) {
        winnerId = this.matchState.innings2.battingPlayerId;
        winReason = "fewer_wickets";
      } else {
        winnerId = this.matchState.innings1.battingPlayerId;
        winReason = "fewer_wickets";
      }
    }

    this.endMatchWithWinner(winnerId, winReason);
  }

  private endMatchWithWinner(winnerId: string, reason: string) {
    this.matchState.winner = winnerId;
    this.matchState.winReason = reason;
    this.matchState.phase = "result";

    const winner = this.getPlayerByPlayerId(winnerId);
    const loserId = this.getOpponentPlayerId(winnerId) ?? "";
    const loser = this.getPlayerByPlayerId(loserId);

    // Calculate ELO
    const eloDelta = this.calculateElo(
      winner?.elo ?? 1000,
      loser?.elo ?? 1000
    );
    this.matchState.eloDelta = eloDelta;

    console.log(
      `[MyRoom ${this.roomId}] Match End: ${winner?.name} wins (${reason}). ` +
        `ELO: ±${eloDelta}`
    );

    this.broadcast("match_end", {
      winnerId,
      winnerName: winner?.name,
      loserId,
      loserName: loser?.name,
      reason,
      finalScore: {
        innings1: this.matchState.innings1.score,
        innings1Wickets: this.matchState.innings1.wickets,
        innings2: this.matchState.innings2.score,
        innings2Wickets: this.matchState.innings2.wickets,
      },
      eloDelta,
      winnerRewards: {
        coins: 50,
        xp: 30,
        trophies: 30,
      },
      loserRewards: {
        coins: 15,
        xp: 10,
        trophies: -20,
      },
    });

    this.clock.setTimeout(() => this.disconnect(), 5000);
  }

  private endMatchDraw() {
    this.matchState.winner = "";
    this.matchState.winReason = "draw";
    this.matchState.phase = "result";
    this.matchState.eloDelta = 0;

    console.log(`[MyRoom ${this.roomId}] Match End: DRAW`);

    this.broadcast("match_end", {
      winnerId: "",
      reason: "draw",
      finalScore: {
        innings1: this.matchState.innings1.score,
        innings1Wickets: this.matchState.innings1.wickets,
        innings2: this.matchState.innings2.score,
        innings2Wickets: this.matchState.innings2.wickets,
      },
      eloDelta: 0,
      drawRewards: {
        coins: 25,
        xp: 15,
        trophies: 5,
      },
    });

    this.clock.setTimeout(() => this.disconnect(), 5000);
  }

  private endMatchByDisconnect(disconnectedPlayerId: string) {
    const opponentId = this.getOpponentPlayerId(disconnectedPlayerId);
    if (!opponentId || this.matchState.phase === "result") return;

    this.endMatchWithWinner(opponentId, "disconnect");
  }

  // ==========================================================================
  // FORFEIT
  // ==========================================================================

  private handleForfeit(client: Client) {
    const player = this.matchState.players.get(client.sessionId) as PlayerState;
    if (!player || this.matchState.phase === "result") return;

    const opponent = this.getOpponentBySessionId(client.sessionId);
    if (!opponent) return;

    console.log(
      `[MyRoom ${this.roomId}] ${player.name} forfeited. ${opponent.name} wins.`
    );

    this.endMatchWithWinner(opponent.playerId, "forfeit");
  }

  // ==========================================================================
  // ELO
  // ==========================================================================

  private calculateElo(winnerElo: number, loserElo: number): number {
    const K = 32;
    const expectedWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    return Math.round(K * (1 - expectedWin));
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  private getCurrentInnings(): InningsData | null {
    switch (this.matchState.phase) {
      case "innings1":
        return this.matchState.innings1;
      case "innings2":
        return this.matchState.innings2;
      case "super_over_1":
        return this.matchState.superOverInnings1;
      case "super_over_2":
        return this.matchState.superOverInnings2;
      default:
        return null;
    }
  }

  private getInningsNumber(): number {
    switch (this.matchState.phase) {
      case "innings1": return 1;
      case "innings2": return 2;
      case "super_over_1": return 3;
      case "super_over_2": return 4;
      default: return 0;
    }
  }

  private getMaxBallsForInnings(): number {
    const isSuperOver = ["super_over_1", "super_over_2"].includes(
      this.matchState.phase
    );
    const overs = isSuperOver ? 1 : this.matchState.oversPerMatch;
    return overs * this.matchState.ballsPerOver;
  }

  private getBallsPerInnings(): number {
    return this.matchState.ballsPerOver;
  }

  private getBowlerPlayer(innings: InningsData): PlayerState | undefined {
    return this.getPlayerByPlayerId(innings.bowlingPlayerId);
  }

  private getBatterPlayer(innings: InningsData): PlayerState | undefined {
    return this.getPlayerByPlayerId(innings.battingPlayerId);
  }

  private getBowlerCardRole(innings: InningsData): string {
    const bowler = this.getBowlerPlayer(innings);
    if (!bowler?.activeBowlerCardId) return "fast";

    const card = Array.from(bowler.bowlingCards).find(
      (c: DeckCard) => c.cardId === bowler.activeBowlerCardId
    );
    if (!card) return "fast";

    return card.role === "BowlingSpin" ? "spin" : "fast";
  }

  private getPlayerByPlayerId(playerId: string): PlayerState | undefined {
    for (const player of this.matchState.players.values()) {
      if ((player as PlayerState).playerId === playerId) {
        return player as PlayerState;
      }
    }
    return undefined;
  }

  private getOpponentPlayerId(playerId: string): string | undefined {
    for (const player of this.matchState.players.values()) {
      if ((player as PlayerState).playerId !== playerId) {
        return (player as PlayerState).playerId;
      }
    }
    return undefined;
  }

  private getOpponentBySessionId(sessionId: string): PlayerState | undefined {
    for (const [sid, player] of this.matchState.players.entries()) {
      if (sid !== sessionId) return player as PlayerState;
    }
    return undefined;
  }

  private getClientByPlayerId(playerId: string): Client | undefined {
    for (const [sessionId, player] of this.matchState.players.entries()) {
      if ((player as PlayerState).playerId === playerId) {
        return this.clientMap.get(sessionId);
      }
    }
    return undefined;
  }

  private resendCurrentState(client: Client) {
    // Resend relevant state for reconnected player
    const innings = this.getCurrentInnings();
    if (!innings) return;

    client.send("reconnect_state", {
      phase: this.matchState.phase,
      score: innings.score,
      wickets: innings.wickets,
      ballsBowled: innings.ballsBowled,
      target: innings.target,
      battingPlayerId: innings.battingPlayerId,
      bowlingPlayerId: innings.bowlingPlayerId,
    });
  }

  private generateRoomCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
