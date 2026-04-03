import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../src/app.config.js";

/**
 * MatchRoom Super Over Tests
 *
 * SLIDER_VALUES = [1, 2, 3, 4, 6, -1]  →  6 zones.
 *   pos 0.00 → zone 0 → 1 run
 *   pos 0.99 → zone 5 → wicket (-1)
 */

describe("MatchRoom – Super Over", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => colyseus = await boot(appConfig));
    after(async () => colyseus.shutdown());
    beforeEach(async () => await colyseus.cleanup());

    const DECK = {
        deckId: "d1",
        battingCards: [
            { cardId: "bat1", name: "B1", role: "BattingStrategy", rarity: "Common", powerType: "", basePower: 1, level: 1 },
            { cardId: "bat2", name: "B2", role: "BattingDefense",  rarity: "Common", powerType: "", basePower: 1, level: 1 },
        ],
        bowlingCards: [
            { cardId: "bow1", name: "W1", role: "BowlingFast", rarity: "Common", powerType: "", basePower: 1, level: 1 },
            { cardId: "bow2", name: "W2", role: "BowlingSpin", rarity: "Common", powerType: "", basePower: 1, level: 1 },
        ],
    };

    function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

    /** Poll room state until predicate is true. Uses real time delays. */
    async function waitUntil(room: any, pred: () => boolean, label: string, ms = 12000) {
        const start = Date.now();
        while (!pred()) {
            if (Date.now() - start > ms) throw new Error(`waitUntil timed out: ${label} (phase=${room.state.phase})`);
            await delay(50);
            await room.waitForNextSimulationTick();
        }
    }

    async function createMatch(overrides: Record<string, any> = {}) {
        const room = await colyseus.createRoom("match_room", {
            oversPerMatch: 1, ballsPerOver: 1, ...overrides,
        });
        const c1 = await colyseus.connectTo(room, { playerId: "p1", playerName: "Alice" });
        const c2 = await colyseus.connectTo(room, { playerId: "p2", playerName: "Bob" });
        await room.waitForNextPatch();
        return { room, c1, c2 };
    }

    async function completeTossAndDeck(room: any, c1: any, c2: any) {
        await waitUntil(room, () => room.state.phase === "toss_choice", "toss_choice");
        const caller = room.state.tossCaller === c1.sessionId ? c1 : c2;
        caller.send("toss_choice", { choice: "heads" });

        await waitUntil(room, () => room.state.phase === "toss_decision", "toss_decision");
        const winner = room.state.tossWinner === c1.sessionId ? c1 : c2;
        winner.send("toss_bat_bowl", { choice: "bat" });

        await waitUntil(room, () => room.state.phase === "deck_confirm", "deck_confirm");
        c1.send("deck_confirm", DECK);
        c2.send("deck_confirm", DECK);
    }

    /** Identify batter / bowler from the active innings batting player ID. */
    function roles(room: any, c1: any, c2: any) {
        // Find whichever innings is currently active
        let inn = room.state.innings1;
        if (room.state.innings1.isComplete && !room.state.innings2.isComplete) inn = room.state.innings2;
        if (room.state.phase === "super_over") {
            inn = !room.state.superOverInnings1.isComplete
                ? room.state.superOverInnings1
                : room.state.superOverInnings2;
        }
        const p1 = room.state.players.get(c1.sessionId);
        const isBatter = p1?.playerId === inn.battingPlayerId;
        return { batter: isBatter ? c1 : c2, bowler: isBatter ? c2 : c1 };
    }

    async function playOneBall(room: any, c1: any, c2: any, tapPos: number) {
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "awaitingBowler");
        const { batter, bowler } = roles(room, c1, c2);
        bowler.send("select_bowler", { cardId: "bow1" });

        await waitUntil(room, () => !room.state.awaitingBowlerSelection, "bowlerSelected");
        await delay(100);
        batter.send("select_batsman", { cardId: "bat1" });

        await waitUntil(room, () => room.state.awaitingBatsmanTap, "awaitingTap");
        batter.send("batsman_tap", { position: tapPos });
        await waitUntil(room, () => !room.state.awaitingBatsmanTap, "ballResolved");
    }

    // ── Tests ─────────────────────────────────────────────────────────────

    it("triggers super over when main match is tied", async () => {
        const { room, c1, c2 } = await createMatch();
        await completeTossAndDeck(room, c1, c2);

        await waitUntil(room, () => room.state.phase === "innings1", "innings1");
        await playOneBall(room, c1, c2, 0.0);  // 1 run

        await waitUntil(room, () => room.state.phase === "innings2" || room.state.phase === "innings_break", "break/inn2");
        await waitUntil(room, () => room.state.phase === "innings2", "innings2");
        await playOneBall(room, c1, c2, 0.0);  // 1 run → TIE

        await waitUntil(room, () => room.state.phase === "super_over", "super_over");
        assert.strictEqual(room.state.innings1.score, 1);
        assert.strictEqual(room.state.innings2.score, 1);
    });

    it("draws when tied and superOverEnabled=false", async () => {
        const { room, c1, c2 } = await createMatch();
        room.state.superOverEnabled = false;

        await completeTossAndDeck(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");
        await playOneBall(room, c1, c2, 0.0);

        await waitUntil(room, () => room.state.phase === "innings2", "innings2", 12000);
        await playOneBall(room, c1, c2, 0.0);

        await waitUntil(room, () => room.state.phase === "result", "result");
        assert.strictEqual(room.state.winReason, "draw");
        assert.strictEqual(room.state.winner, "");
    });

    it("completes super over with a winner", async () => {
        const { room, c1, c2 } = await createMatch();
        await completeTossAndDeck(room, c1, c2);

        // Main match: both score 1 → tie → super over
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");
        await playOneBall(room, c1, c2, 0.0);
        await waitUntil(room, () => room.state.phase === "innings2", "innings2", 12000);
        await playOneBall(room, c1, c2, 0.0);
        await waitUntil(room, () => room.state.phase === "super_over", "super_over");

        // SO innings 1: wait for it to start, then score 4 runs
        await waitUntil(room, () =>
            room.state.superOverInnings1.battingPlayerId !== "",
            "SO1 start", 12000);
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "SO1 bowler");
        await playOneBall(room, c1, c2, 0.55); // zone 3 → 4 runs

        // SO innings 2: wait for it to start, then score 1 run (can't chase 5)
        await waitUntil(room, () =>
            room.state.superOverInnings1.isComplete,
            "SO1 complete", 12000);
        await waitUntil(room, () =>
            room.state.superOverInnings2.battingPlayerId !== "",
            "SO2 start", 12000);
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "SO2 bowler");
        await playOneBall(room, c1, c2, 0.0); // zone 0 → 1 run

        // Match should resolve with super_over win
        await waitUntil(room, () => room.state.phase === "result", "result", 12000);
        assert.ok(
            room.state.winReason === "super_over" || room.state.winReason === "super_over_wickets",
            `Expected super_over win reason, got: ${room.state.winReason}`
        );
        assert.notStrictEqual(room.state.winner, "");
        assert.strictEqual(room.state.superOverInnings1.score, 4);
        assert.strictEqual(room.state.superOverInnings2.score, 1);
    }).timeout(30000);

    it("uses wickets tiebreaker when super over scores are also tied", async () => {
        const { room, c1, c2 } = await createMatch();
        await completeTossAndDeck(room, c1, c2);

        // Main match: both score 1
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");
        await playOneBall(room, c1, c2, 0.0);
        await waitUntil(room, () => room.state.phase === "innings2", "innings2", 12000);
        await playOneBall(room, c1, c2, 0.0);
        await waitUntil(room, () => room.state.phase === "super_over", "super_over");

        // SO innings 1: wicket → 0 runs, 1 wkt (out in super over = innings over)
        await waitUntil(room, () =>
            room.state.superOverInnings1.battingPlayerId !== "",
            "SO1 start", 12000);
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "SO1 bowler");
        await playOneBall(room, c1, c2, 0.99); // zone 5 → wicket

        // SO innings 2: wicket → 0 runs, 1 wkt. Same score + same wickets = draw
        await waitUntil(room, () =>
            room.state.superOverInnings1.isComplete,
            "SO1 complete", 12000);
        await waitUntil(room, () =>
            room.state.superOverInnings2.battingPlayerId !== "",
            "SO2 start", 12000);
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "SO2 bowler");
        await playOneBall(room, c1, c2, 0.99); // zone 5 → wicket

        // Both SO innings: 0 runs, 1 wicket each → same wickets → draw
        await waitUntil(room, () => room.state.phase === "result", "result", 12000);
        assert.strictEqual(room.state.winReason, "draw");
        assert.strictEqual(room.state.superOverInnings1.score, 0);
        assert.strictEqual(room.state.superOverInnings2.score, 0);
    }).timeout(30000);

    // ── Power Effect Tests ──────────────────────────────────────────────────

    const POWER_DECK = {
        deckId: "pd1",
        battingCards: [
            { cardId: "bat1", name: "B1", role: "BattingStrategy", rarity: "Rare", powerType: "DoubleScore", basePower: 2, level: 1 },
            { cardId: "bat2", name: "B2", role: "BattingDefense",  rarity: "Rare", powerType: "ShieldWicket", basePower: 2, level: 1 },
        ],
        bowlingCards: [
            { cardId: "bow1", name: "W1", role: "BowlingFast", rarity: "Common", powerType: "", basePower: 1, level: 1 },
            { cardId: "bow2", name: "W2", role: "BowlingSpin", rarity: "Common", powerType: "", basePower: 1, level: 1 },
        ],
    };

    function createPowerMatch(overrides: Record<string, any> = {}) {
        return createMatch({ oversPerMatch: 1, ballsPerOver: 2, ...overrides });
    }

    async function completeTossAndDeckPower(room: any, c1: any, c2: any) {
        await waitUntil(room, () => room.state.phase === "toss_choice", "toss_choice");
        const caller = room.state.tossCaller === c1.sessionId ? c1 : c2;
        caller.send("toss_choice", { choice: "heads" });
        await waitUntil(room, () => room.state.phase === "toss_decision", "toss_decision");
        const winner = room.state.tossWinner === c1.sessionId ? c1 : c2;
        winner.send("toss_bat_bowl", { choice: "bat" });
        await waitUntil(room, () => room.state.phase === "deck_confirm", "deck_confirm");
        c1.send("deck_confirm", POWER_DECK);
        c2.send("deck_confirm", POWER_DECK);
    }

    async function playOneBallWithPower(
        room: any, c1: any, c2: any, tapPos: number,
        power?: { powerId: string; cardId: string; who: "batter" | "bowler" },
    ) {
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "awaitingBowler");
        const { batter, bowler } = roles(room, c1, c2);
        bowler.send("select_bowler", { cardId: "bow1" });
        await waitUntil(room, () => !room.state.awaitingBowlerSelection, "bowlerSelected");
        await delay(100);
        batter.send("select_batsman", { cardId: power?.cardId || "bat1" });
        await waitUntil(room, () => room.state.awaitingBatsmanTap, "awaitingTap");
        if (power) {
            const activator = power.who === "batter" ? batter : bowler;
            activator.send("power_activate", { powerId: power.powerId, cardId: power.cardId });
            await delay(100);
        }
        batter.send("batsman_tap", { position: tapPos });
        await waitUntil(room, () => !room.state.awaitingBatsmanTap, "ballResolved");
    }

    it("DoubleScore doubles run value", async () => {
        const { room, c1, c2 } = await createPowerMatch();
        await completeTossAndDeckPower(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        await playOneBallWithPower(room, c1, c2, 0.0, {
            powerId: "DoubleScore", cardId: "bat1", who: "batter",
        });
        assert.strictEqual(room.state.innings1.score, 2, "Score should be 2 (1 run doubled)");

        await playOneBallWithPower(room, c1, c2, 0.0);
        assert.strictEqual(room.state.innings1.score, 3, "Score should be 3 (2 + 1)");
    }).timeout(15000);

    it("ShieldWicket converts wicket to dot ball", async () => {
        const { room, c1, c2 } = await createPowerMatch();
        await completeTossAndDeckPower(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        await playOneBallWithPower(room, c1, c2, 0.99, {
            powerId: "ShieldWicket", cardId: "bat2", who: "batter",
        });
        assert.strictEqual(room.state.innings1.wickets, 0, "Wickets should be 0 (shielded)");
        assert.strictEqual(room.state.innings1.score, 0, "Score should be 0 (dot ball)");
        assert.strictEqual(room.state.innings1.ballsBowled, 1, "1 ball bowled");
    }).timeout(15000);

    it("rejects power_activate for unknown power type", async () => {
        const { room, c1, c2 } = await createPowerMatch({ ballsPerOver: 1 });
        await completeTossAndDeckPower(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "awaitingBowler");

        const { batter } = roles(room, c1, c2);
        let rejected = false;
        batter.onMessage("power_rejected", () => { rejected = true; });
        batter.send("power_activate", { powerId: "FakePower", cardId: "bat1" });
        await delay(200);
        assert.strictEqual(rejected, true, "Should reject unknown power type");
    }).timeout(15000);
});
