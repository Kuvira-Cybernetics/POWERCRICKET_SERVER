import { Schema, type, ArraySchema, MapSchema } from "@colyseus/schema";

/**
 * All schemas mirror MatchRoomState.cs (Unity client) exactly.
 * The @type() index order must match [Type(index,...)] in C#.
 */

export class TeamPlayer extends Schema {
    @type("string")  playerId:  string = "";   // [Type(0)]
    @type("string")  name:      string = "";   // [Type(1)]
    @type("string")  role:      string = "";   // [Type(2)]
    @type("string")  rarity:    string = "";   // [Type(3)]
    @type("string")  powerType: string = "";   // [Type(4)]
    @type("number")  basePower: number = 1;    // [Type(5)]
    @type("int32")   level:     number = 1;    // [Type(6)]
}

export class PowerUsage extends Schema {
    @type("string")  powerId:       string  = "";    // [Type(0)]
    @type("string")  playerCardId:  string  = "";    // [Type(1)]
    @type("string")  playerId:      string  = "";    // [Type(2)]
    @type("int32")   maxUses:       number  = 1;     // [Type(3)]
    @type("int32")   usesConsumed:  number  = 0;     // [Type(4)]
    @type("boolean") activeThisBall: boolean = false; // [Type(5)]
}

export class BallState extends Schema {
    @type("int32")   ballNumber:     number = 0;  // [Type(0)]
    @type("string")  outcome:        string = "";  // [Type(1)] dot|run|wicket
    @type("int32")   runs:           number = 0;  // [Type(2)]
    @type("string")  bowlerType:     string = "";  // [Type(3)] fast|spin
    @type("string")  bowlerPlayerId:   string = "";  // [Type(4)]
    @type("string")  batsmanPlayerId:  string = "";  // [Type(5)]
    @type("int32")   sliderPosition: number = 0;  // [Type(6)] 0-100
    @type("string")  powerUsed:      string = "";  // [Type(7)]
    @type("number")  arrowSpeed:     number = 1;  // [Type(8)]
    @type("int32")   originalRuns:   number = 0;  // [Type(9)]
    @type("boolean") catchAttempted: boolean = false; // [Type(10)]
    @type("boolean") caughtOut:      boolean = false; // [Type(11)]
}

export class InningsData extends Schema {
    @type("string")    battingPlayerId: string  = "";   // [Type(0)]
    @type("string")    bowlingPlayerId: string  = "";   // [Type(1)]
    @type("int32")     score:           number  = 0;    // [Type(2)]
    @type("int32")     wickets:         number  = 0;    // [Type(3)]
    @type("int32")     ballsBowled:     number  = 0;    // [Type(4)]
    @type("int32")     currentOver:     number  = 0;    // [Type(5)]
    @type("int32")     target:          number  = -1;   // [Type(6)] -1 until innings 2
    @type([BallState]) balls = new ArraySchema<BallState>();  // [Type(7)]
    @type("boolean")   isComplete:      boolean = false; // [Type(8)]
}

export class PowerSlot extends Schema {
    @type("string")  playerId:      string  = "";    // [Type(0)]
    @type("string")  powerId:       string  = "";    // [Type(1)]
    @type("string")  playerCardId:  string  = "";    // [Type(2)]
    @type("boolean") active:        boolean = false; // [Type(3)]
    @type("int32")   usesRemaining: number  = 1;     // [Type(4)]
}

export class PlayerState extends Schema {
    @type("string")   sessionId:           string  = "";    // [Type(0)]
    @type("string")   playerId:            string  = "";    // [Type(1)]
    @type("string")   name:                string  = "";    // [Type(2)]
    @type("int32")    elo:                 number  = 1000;  // [Type(3)]
    @type("string")       teamId:                string  = "";    // [Type(4)]
    @type("boolean")      connected:             boolean = true;  // [Type(5)]
    @type("boolean")      ready:                 boolean = false; // [Type(6)]
    @type([TeamPlayer])   battingPlayers = new ArraySchema<TeamPlayer>(); // [Type(7)]
    @type([TeamPlayer])   bowlingPlayers = new ArraySchema<TeamPlayer>(); // [Type(8)]
    @type("string")       activeBatsmanPlayerId: string  = "";    // [Type(9)]
    @type("string")       activeBowlerPlayerId:  string  = "";    // [Type(10)]
    @type("boolean")  isSpeaking:          boolean = false; // [Type(11)] PTT speaking indicator
    @type("boolean")  selectionReady:      boolean = false; // [Type(12)] Post-toss player selection ready
}

export class MatchRoomState extends Schema {
    @type("string")  matchId:    string  = "";      // [Type(0)]
    @type("string")  phase:      string  = "lobby"; // [Type(1)] lobby→toss→toss_choice→toss_decision→deck_confirm→innings1→innings_break→innings2→super_over→result
    @type("string")  tossWinner: string  = "";      // [Type(2)]
    @type("string")  tossChoice: string  = "";      // [Type(3)] bat|bowl
    @type("string")  tossCaller: string  = "";      // [Type(4)]

    @type("int32")   oversPerMatch:    number  = 3;     // [Type(5)]
    @type("int32")   ballsPerOver:     number  = 6;     // [Type(6)]
    @type("int32")   maxWickets:       number  = 1;     // [Type(7)] Dynamically set per innings in startInnings() = battingCards - 1
    @type("boolean") superOverEnabled: boolean = true;  // [Type(8)]

    @type({ map: PlayerState }) players = new MapSchema<PlayerState>(); // [Type(9)]

    @type(InningsData) innings1          = new InningsData(); // [Type(10)]
    @type(InningsData) innings2          = new InningsData(); // [Type(11)]
    @type(InningsData) superOverInnings1 = new InningsData(); // [Type(12)]
    @type(InningsData) superOverInnings2 = new InningsData(); // [Type(13)]

    @type([PowerSlot])           activePowers = new ArraySchema<PowerSlot>();   // [Type(14)]
    @type({ map: PowerUsage })   powerUsages  = new MapSchema<PowerUsage>();    // [Type(15)]

    @type("string")  winner:    string  = "";  // [Type(16)]
    @type("string")  winReason: string  = "";  // [Type(17)] chase|defended|super_over|super_over_wickets|forfeit|disconnect|draw
    @type("int32")   eloDelta:  number  = 0;   // [Type(18)]

    @type("boolean") isPrivate: boolean = false; // [Type(19)]
    @type("string")  roomCode:  string  = "";    // [Type(20)]
    @type("number")  createdAt: number  = 0;     // [Type(21)]

    @type("boolean") awaitingBowlerSelection: boolean = false; // [Type(22)]
    @type("boolean") awaitingBatsmanTap:      boolean = false; // [Type(23)]
    @type("number")  currentBallArrowSpeed:   number  = 1;     // [Type(24)]
    @type("boolean") awaitingBowlerPattern:   boolean = false; // [Type(25)]
    @type("boolean") awaitingFielderTap:      boolean = false; // [Type(26)]
}

