import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

// import your "app.config.ts" file here.
import appConfig from "../src/app.config.js";
import { MatchRoomState } from "../src/rooms/schema/MyRoomState.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => await colyseus.cleanup());

  it("connecting into a room", async () => {
    // `room` is the server-side Room instance reference.
    const room = await colyseus.createRoom<MatchRoomState>("my_room", {});

    // `client1` is the client-side `Room` instance reference (same as JavaScript SDK)
    const client1 = await colyseus.connectTo(room);

    // make your assertions
    assert.strictEqual(client1.sessionId, room.clients[0].sessionId);

    // wait for state sync
    await room.waitForNextPatch();

    // Verify match state is initialized
    const state = client1.state.toJSON() as any;
    assert.strictEqual(state.phase, "lobby");
    assert.strictEqual(state.oversPerMatch, 3);
    assert.strictEqual(state.ballsPerOver, 6);
  });

  it("two players can join and trigger toss", async () => {
    const room = await colyseus.createRoom<MatchRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { playerName: "Player1", elo: 1000 });
    const client2 = await colyseus.connectTo(room, { playerName: "Player2", elo: 1050 });

    await room.waitForNextPatch();

    const state = client1.state.toJSON() as any;
    assert.strictEqual(Object.keys(state.players).length, 2);
  });
});
