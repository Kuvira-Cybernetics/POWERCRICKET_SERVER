import { Schema, type } from "@colyseus/schema";

export class LobbyRoomState extends Schema {
  @type("uint16") playersWaiting: number = 0;
  @type("float32") averageWaitTimeSeconds: number = 0;
  @type("string") matchmakingStatus: string = "idle";
  @type("string") messageOfTheDay: string = "Welcome to Power Cricket!";
}
