import { Schema, type, ArraySchema, MapSchema } from "@colyseus/schema";

/**
 * DeckCard - A card in a player's deck with role and power info
 */
export class DeckCard extends Schema {
  @type("string")
  cardId: string = "";

  @type("string")
  name: string = "";

  @type("string")
  role: string = ""; // BattingStrategy, BattingDefense, BowlingFast, BowlingSpin

  @type("string")
  rarity: string = ""; // Common, Rare, Epic, Legendary

  @type("string")
  powerType: string = "";

  @type("number")
  basePower: number = 1.0;

  @type("number")
  level: number = 1;
}

/**
 * PowerUsage - Tracks a triggered power's usage within a match
 */
export class PowerUsage extends Schema {
  @type("string")
  powerId: string = "";

  @type("string")
  cardId: string = "";

  @type("string")
  playerId: string = "";

  @type("number")
  maxUses: number = 1;

  @type("number")
  usesConsumed: number = 0;

  @type("boolean")
  activeThisBall: boolean = false;
}

/**
 * BallState - Represents a single ball delivered in an innings
 */
export class BallState extends Schema {
  @type("number")
  ballNumber: number = 0;

  @type("string")
  outcome: string = ""; // dot/run/wicket/catch/catch_dropped

  @type("number")
  runs: number = 0;

  @type("string")
  bowlerType: string = ""; // fast/spin

  @type("string")
  bowlerCardId: string = "";

  @type("string")
  batsmanCardId: string = "";

  @type("number")
  sliderPosition: number = 0; // 0-100 representing slider input

  @type("string")
  powerUsed: string = ""; // powerId if a power was used this ball

  @type("number")
  arrowSpeed: number = 1.0; // actual arrow speed sent to client

  @type("number")
  originalRuns: number = 0; // runs before power modifiers
}

/**
 * InningsData - Represents a complete innings (batting + bowling)
 */
export class InningsData extends Schema {
  @type("string")
  battingPlayerId: string = "";

  @type("string")
  bowlingPlayerId: string = "";

  @type("number")
  score: number = 0;

  @type("number")
  wickets: number = 0;

  @type("number")
  ballsBowled: number = 0;

  @type("number")
  currentOver: number = 0;

  @type("number")
  target: number = -1; // -1 until target is set (innings 2)

  @type([BallState])
  balls: ArraySchema<BallState> = new ArraySchema<BallState>();

  @type("boolean")
  isComplete: boolean = false;
}

/**
 * PowerSlot - Represents an active power in the match (legacy compat + active display)
 */
export class PowerSlot extends Schema {
  @type("string")
  playerId: string = "";

  @type("string")
  powerId: string = "";

  @type("string")
  cardId: string = "";

  @type("boolean")
  active: boolean = false;

  @type("number")
  usesRemaining: number = 1;
}

/**
 * PlayerState - Represents a player in the match room
 */
export class PlayerState extends Schema {
  @type("string")
  sessionId: string = "";

  @type("string")
  playerId: string = "";

  @type("string")
  name: string = "";

  @type("number")
  elo: number = 1000;

  @type("string")
  deckId: string = "";

  @type("boolean")
  connected: boolean = true;

  @type("boolean")
  ready: boolean = false;

  @type([DeckCard])
  battingCards: ArraySchema<DeckCard> = new ArraySchema<DeckCard>();

  @type([DeckCard])
  bowlingCards: ArraySchema<DeckCard> = new ArraySchema<DeckCard>();

  @type("string")
  activeBatsmanCardId: string = ""; // current striker card

  @type("string")
  activeBowlerCardId: string = ""; // current bowler card for this delivery
}

/**
 * MatchRoomState - Main game state for a 1v1 cricket match
 * Server-authoritative: all match outcomes determined here
 */
export class MatchRoomState extends Schema {
  @type("string")
  matchId: string = "";

  @type("string")
  phase: string = "lobby";
  // lobby → toss → toss_choice → deck_confirm → innings1 → innings_break → innings2 → super_over → result

  @type("string")
  tossWinner: string = "";

  @type("string")
  tossChoice: string = ""; // bat/bowl

  @type("string")
  tossCaller: string = ""; // playerId selected to call the toss

  @type("number")
  oversPerMatch: number = 3;

  @type("number")
  ballsPerOver: number = 6;

  @type("number")
  maxWickets: number = 10;

  @type("boolean")
  superOverEnabled: boolean = true;

  @type({ map: PlayerState })
  players: MapSchema<PlayerState> = new MapSchema<PlayerState>();

  @type(InningsData)
  innings1: InningsData = new InningsData();

  @type(InningsData)
  innings2: InningsData = new InningsData();

  @type(InningsData)
  superOverInnings1: InningsData = new InningsData();

  @type(InningsData)
  superOverInnings2: InningsData = new InningsData();

  @type([PowerSlot])
  activePowers: ArraySchema<PowerSlot> = new ArraySchema<PowerSlot>();

  @type({ map: PowerUsage })
  powerUsages: MapSchema<PowerUsage> = new MapSchema<PowerUsage>();

  @type("string")
  winner: string = ""; // playerId of winner, empty if match ongoing

  @type("string")
  winReason: string = ""; // chase/defended/super_over/forfeit/disconnect/draw

  @type("number")
  eloDelta: number = 0;

  @type("boolean")
  isPrivate: boolean = false;

  @type("string")
  roomCode: string = "";

  @type("number")
  createdAt: number = Date.now();

  // Awaiting bowler selection for current ball
  @type("boolean")
  awaitingBowlerSelection: boolean = false;

  // Awaiting batsman tap for current ball
  @type("boolean")
  awaitingBatsmanTap: boolean = false;

  @type("number")
  currentBallArrowSpeed: number = 1.0;
}
