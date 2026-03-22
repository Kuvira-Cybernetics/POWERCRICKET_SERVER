import { Schema, type, ArraySchema, MapSchema } from "@colyseus/schema";

export class CardState extends Schema {
  @type("string") cardId: string = "";
  @type("string") cardTemplateId: string = "";
  @type("uint8") level: number = 1;
  @type("boolean") powerAvailable: boolean = true;
  @type("uint8") powerCooldownRemaining: number = 0;
}

export class PlayerState extends Schema {
  @type("string") playerId: string = "";
  @type("string") displayName: string = "";
  @type("uint16") elo: number = 0;
  @type("string") deckId: string = "";
  @type(["string"]) selectedCardIds = new ArraySchema<string>();
  @type("uint32") connectionId: number = 0;
  @type("boolean") isConnected: boolean = true;
  @type("uint64") lastHeartbeatTimestamp: number = 0;
}

export class MatchRoomState extends Schema {
  @type("string") matchId: string = "";
  @type("string") player1Id: string = "";
  @type("string") player2Id: string = "";
  @type("string") phase: string = "lobby";
  @type("uint8") ball: number = 0;
  @type("uint8") over: number = 0;
  @type("uint16") player1Score: number = 0;
  @type("uint16") player2Score: number = 0;
  @type("uint8") player1Wickets: number = 0;
  @type("uint8") player2Wickets: number = 0;
  @type("string") currentBatsmanCardId: string = "";
  @type("string") currentBowlerCardId: string = "";
  @type("string") tossBattingTeam: string = "";
  @type("boolean") tossTaken: boolean = false;
  @type("string") activePowersList: string = "";
  @type("uint64") lastUpdateTimestamp: number = 0;
  @type("uint8") currentOverRuns: number = 0;
  @type("uint32") matchDurationMs: number = 0;
  @type("uint16") inningsTarget: number = 0;
  @type("boolean") player1Connected: boolean = true;
  @type("boolean") player2Connected: boolean = true;
  @type("uint8") graceRemainSeconds: number = 0;
  @type("string") reconnectionToken: string = "";

  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: CardState }) cards = new MapSchema<CardState>();
}
