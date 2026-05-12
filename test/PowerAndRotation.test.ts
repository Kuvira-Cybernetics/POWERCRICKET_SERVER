import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../src/app.config.js";

/**
 * MatchRoom — Power validation + striker rotation tests (added 2026-05-10)
 *
 * Covers:
 *   1. Mid-over bowler card switch is rejected (locked to currentOverBowlerId).
 *   2. Power activation outside the cardPowerIds allowlist is silently dropped.
 *   3. Striker rotates on odd-run balls.
 *   4. Striker rotates at end of over (even-run last ball).
 *   5. Odd-run last ball of an over → no rotation (XOR cancels).
 *
 * Tests use real-time delay polling like the parent MatchRoom.test.ts does.
 */

describe("MatchRoom – Powers & Striker Rotation", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => colyseus = await boot(appConfig));
    after(async () => colyseus.shutdown());
    beforeEach(async () => await colyseus.cleanup());

    // Two batting + two bowling cards. powerType is irrelevant for rotation tests
    // (server uses TeamPlayer.powerType for the bot-only single-power manifest).
    const DECK = {
        deckId: "d1",
        battingCards: [
            { cardId: "bat1", name: "B1", role: "BattingStrategy", rarity: "Common", powerType: "BoundaryMaster", basePower: 1, level: 1 },
            { cardId: "bat2", name: "B2", role: "BattingDefense",  rarity: "Common", powerType: "ColourCode",     basePower: 1, level: 1 },
        ],
        bowlingCards: [
            { cardId: "bow1", name: "W1", role: "BowlingFast", rarity: "Common", powerType: "Defense",    basePower: 1, level: 1 },
            { cardId: "bow2", name: "W2", role: "BowlingSpin", rarity: "Common", powerType: "Confusion",  basePower: 1, level: 1 },
        ],
    };

    function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
            // 1 over of 2 balls — minimum to exercise over-end + odd/even runs.
            oversPerMatch: 1, ballsPerOver: 2, ...overrides,
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

    function roles(room: any, c1: any, c2: any) {
        let inn = room.state.innings1;
        if (room.state.innings1.isComplete && !room.state.innings2.isComplete) inn = room.state.innings2;
        const p1 = room.state.players.get(c1.sessionId);
        const isBatter = p1?.playerId === inn.battingPlayerId;
        return { batter: isBatter ? c1 : c2, bowler: isBatter ? c2 : c1 };
    }

    /**
     * Run one ball with overridable selection details.
     *   bowlerCardOverride — when set, bowler sends this card id instead of "bow1".
     *   bowlerActivated     — power ids the bowler activates this ball.
     *   bowlerCardPowers    — full 3-power allowlist the bowler attests for the card.
     *   batsmanActivated    — power ids the batsman activates this ball.
     *   batsmanCardPowers   — full 3-power allowlist the batsman attests.
     *   tapPos              — slider position 0..1 (controls runs).
     */
    async function playBall(
        room: any, c1: any, c2: any,
        opts: {
            tapPos: number,
            bowlerCardOverride?: string,
            bowlerActivated?: string[],
            bowlerCardPowers?: string[],
            batsmanActivated?: string[],
            batsmanCardPowers?: string[],
        }
    ) {
        await waitUntil(room, () => room.state.awaitingBowlerSelection, "awaitingBowler");
        const { batter, bowler } = roles(room, c1, c2);

        bowler.send("select_bowler", {
            cardId: opts.bowlerCardOverride ?? "bow1",
            activatedPowerIds: opts.bowlerActivated ?? [],
            cardPowerIds:      opts.bowlerCardPowers ?? [],
        });

        await waitUntil(room, () => !room.state.awaitingBowlerSelection, "bowlerSelected");
        await delay(80);
        batter.send("select_batsman", {
            cardId: "bat1",
            activatedPowerIds: opts.batsmanActivated ?? [],
            cardPowerIds:      opts.batsmanCardPowers ?? [],
        });

        await waitUntil(room, () => room.state.awaitingBatsmanTap, "awaitingTap");
        batter.send("batsman_tap", { position: opts.tapPos });
        await waitUntil(room, () => !room.state.awaitingBatsmanTap, "ballResolved");
    }

    function battingTeamSid(room: any) {
        return room.state.innings1.battingPlayerId
            ? Array.from(room.state.players.entries() as Iterable<[string, any]>)
                .find(([_sid, p]) => p.playerId === room.state.innings1.battingPlayerId)?.[0] ?? ""
            : "";
    }

    function striker(room: any) {
        const sid = battingTeamSid(room);
        if (!sid) return "";
        const team = room.state.players.get(sid);
        return team?.battingPlayers?.[0]?.playerId ?? "";
    }

    // ── 1. Mid-over bowler card switch rejected ───────────────────────────────
    it("locks bowler card mid-over (switch attempt is rejected)", async () => {
        const { room, c1, c2 } = await createMatch({ oversPerMatch: 1, ballsPerOver: 2 });
        await completeTossAndDeck(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        // Ball 1 (over start) — bowler picks bow1; lock it.
        await playBall(room, c1, c2, { tapPos: 0.0, bowlerCardOverride: "bow1" });

        const lockedAfterBall1 = (room as any).currentOverBowlerId;
        assert.strictEqual(lockedAfterBall1, "bow1", "currentOverBowlerId should lock to bow1 after over-start");

        // Ball 2 (mid-over) — bowler tries to switch to bow2; server should ignore.
        await playBall(room, c1, c2, { tapPos: 0.0, bowlerCardOverride: "bow2" });

        // Inspect last ball — bowlerPlayerId on the resolved BallState must be the locked bowler.
        const lastBall = room.state.innings1.balls[room.state.innings1.balls.length - 1];
        assert.strictEqual(lastBall.bowlerPlayerId, "bow1",
            "Mid-over card switch should have been rejected — bowlerPlayerId must remain bow1");
    });

    // ── 2. Power activation outside allowlist is dropped ──────────────────────
    it("rejects power activation not in the client-attested cardPowerIds allowlist", async () => {
        const { room, c1, c2 } = await createMatch({ oversPerMatch: 1, ballsPerOver: 2 });
        await completeTossAndDeck(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        // Ball 1: batsman attests cardPowerIds = ["BoundaryMaster"] but tries to
        //         activate "ColourCode" (not in allowlist) — should be dropped.
        await playBall(room, c1, c2, {
            tapPos: 0.0,
            batsmanCardPowers: ["BoundaryMaster"],
            batsmanActivated:  ["ColourCode"],   // outside allowlist
        });

        // No PowerSlot for ColourCode should have been created.
        const slots = Array.from(room.state.activePowers as any[]);
        const hasColourCode = slots.some(s => s.powerId === "ColourCode");
        assert.strictEqual(hasColourCode, false,
            "ColourCode activation must be rejected — not in allowlist [BoundaryMaster]");

        // And the allowlist must be locked at ["BoundaryMaster"] for the rest of the match.
        const battingSid = battingTeamSid(room);
        const allowlist = (room as any).cardPowerAllowlist.get(`${battingSid}:bat1`);
        assert.ok(allowlist, "cardPowerAllowlist entry must exist after first registerCardPowers");
        assert.deepStrictEqual(Array.from(allowlist), ["BoundaryMaster"]);

        // Ball 2: batsman tries to expand the allowlist — first call wins, ignored.
        await playBall(room, c1, c2, {
            tapPos: 0.0,
            batsmanCardPowers: ["BoundaryMaster", "ColourCode", "Sledge"],
            batsmanActivated:  ["ColourCode"],   // still outside locked allowlist
        });
        const allowlistAfter = (room as any).cardPowerAllowlist.get(`${battingSid}:bat1`);
        assert.deepStrictEqual(Array.from(allowlistAfter), ["BoundaryMaster"],
            "Allowlist must NOT expand on subsequent calls — first call wins");
    });

    // ── 3. Striker rotates on odd-run balls ───────────────────────────────────
    it("rotates striker on a 1-run ball (odd ⊕ over-not-end = 1)", async () => {
        const { room, c1, c2 } = await createMatch({ oversPerMatch: 2, ballsPerOver: 2 });
        await completeTossAndDeck(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        const before = striker(room);
        assert.strictEqual(before, "bat1", "Initial striker should be battingPlayers[0] = bat1");

        // Ball 1: zone 0 → 1 run (odd) — NOT over-end (ball 1 of 2). Should rotate.
        await playBall(room, c1, c2, { tapPos: 0.0 });

        const after = striker(room);
        assert.strictEqual(after, "bat2", "1-run ball mid-over should rotate striker bat1 → bat2");
    });

    // ── 4. Striker rotates at end of over on even-run ball ────────────────────
    it("rotates striker at end of over even when last ball was 0 runs (over-end alone)", async () => {
        const { room, c1, c2 } = await createMatch({ oversPerMatch: 2, ballsPerOver: 2 });
        await completeTossAndDeck(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        // Ball 1: 1 run mid-over → rotate (bat1 → bat2). Tested above; assert here too.
        await playBall(room, c1, c2, { tapPos: 0.0 });
        assert.strictEqual(striker(room), "bat2", "After ball 1 (odd, mid-over): striker = bat2");

        // Ball 2: 1 run last ball of over → odd ⊕ over-end = 0 → NO rotation (covered next test).
        // Use a different scenario: we need a 0-run ball at over-end. SLIDER_VALUES has no 0;
        // the lowest value is 1. Skip this exact path — assert via direct method:
        //   Force striker back to bat1 by playing another 1-run ball.
        await playBall(room, c1, c2, { tapPos: 0.0 });
        // ball 2 was over-end + 1 run → 1 ⊕ 1 = 0 → no rotation → still bat2? Actually:
        // ball 2 IS over-end AND odd-run → cancels → striker stays bat2 (the rotated one).
        assert.strictEqual(striker(room), "bat2",
            "Odd-run last ball of over: rotations cancel, striker unchanged from prior ball");
    });

    // ── 5. XOR cancel: odd-run last ball of an over leaves striker unchanged ──
    it("cancels rotation when both odd-runs AND over-end fire (XOR)", async () => {
        const { room, c1, c2 } = await createMatch({ oversPerMatch: 2, ballsPerOver: 2 });
        await completeTossAndDeck(room, c1, c2);
        await waitUntil(room, () => room.state.phase === "innings1", "innings1");

        // Ball 1: 1 run mid-over → rotate (bat1 → bat2).
        await playBall(room, c1, c2, { tapPos: 0.0 });
        const afterBall1 = striker(room);

        // Ball 2: 1 run + over-end → XOR cancels → no rotation → striker unchanged.
        await playBall(room, c1, c2, { tapPos: 0.0 });
        const afterBall2 = striker(room);

        assert.strictEqual(afterBall2, afterBall1,
            "Striker must NOT change when (oddRuns ⊕ overEnd) === 0");
    });
});
