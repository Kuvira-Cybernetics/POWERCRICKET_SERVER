import { Schema, type } from "@colyseus/schema";

/**
 * LobbyRoomState — mirrors LobbyRoomState in MatchRoomState.cs (Unity client).
 * Field order / types must stay in sync with the C# [Type(index,...)] declarations.
 */
export class LobbyRoomState extends Schema {
    @type("uint16")  playersWaiting: number         = 0;    // [Type(0)]
    @type("float32") averageWaitTimeSeconds: number  = 0;    // [Type(1)]
    @type("string")  matchmakingStatus: string       = "idle";               // [Type(2)]
    @type("string")  messageOfTheDay: string         = "Welcome to Power Cricket!"; // [Type(3)]
}

