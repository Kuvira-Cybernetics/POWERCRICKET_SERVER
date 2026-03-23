import { Room, Client } from "colyseus";
import { ArraySchema } from "@colyseus/schema";
import {
    MatchRoomState, PlayerState, InningsData,
    BallState, DeckCard,
} from "./schema/MatchRoomState.js";

const TOSS_TIMEOUT_MS      = 15_000;
const CARD_SELECT_TIMEOUT  = 10_000;
const BALL_TIMEOUT_MS      = 8_000;
const ELO_DELTA            = 30;
const SLIDER_VALUES        = [1, 2, 3, 4, 6, -1]; // -1 = wicket

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

    // ── Lifecycle ───────────────────────────────────────────────────────────

    onCreate(options: any) {
        this.state = new MatchRoomState();
        this.state.matchId        = options.matchId    || this.roomId;
        this.state.oversPerMatch  = options.oversPerMatch || 3;
        this.state.ballsPerOver   = options.ballsPerOver  || 6;
        this.state.isPrivate      = options.isPrivate     || false;
        this.state.roomCode       = options.roomCode      || "";
        this.state.createdAt      = Date.now();

        this.onMessage("toss_choice",    (c, m) => this.handleTossChoice(c, m));
        this.onMessage("toss_bat_bowl",  (c, m) => this.handleTossBatBowl(c, m));
        this.onMessage("deck_confirm",   (c, m) => this.handleDeckConfirm(c, m));
        this.onMessage("select_bowler",  (c, m) => this.handleSelectBowler(c, m));
        this.onMessage("select_batsman", (c, m) => this.handleSelectBatsman(c, m));
        this.onMessage("batsman_tap",    (c, m) => this.handleBatsmanTap(c, m));
        this.onMessage("power_activate", (c, m) => this.handlePowerActivate(c, m));
        this.onMessage("forfeit",        (c)    => this.handleForfeit(c));
        this.onMessage("heartbeat",      (c)    => c.send("heartbeat_ack", {}));
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
        if (this.clients.length === 2) this.startToss();
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
        console.log(`[MatchRoom] ${this.roomId} disposed`);
    }

    // ── Toss ────────────────────────────────────────────────────────────────

    private startToss() {
        this.state.phase = "toss_choice";
        const keys       = Array.from(this.state.players.keys());
        const callerSid  = keys[Math.floor(Math.random() * 2)];
        const caller     = this.state.players.get(callerSid)!;
        this.state.tossCaller = callerSid;
        this.broadcast("toss_screen", {
            callerId: caller.playerId, callerName: caller.name, timeoutSeconds: TOSS_TIMEOUT_MS / 1000,
        });
    }

    private handleTossChoice(client: Client, msg: { choice: string }) {
        if (this.state.phase !== "toss_choice") return;
        if (client.sessionId !== this.state.tossCaller) return;

        const coin   = Math.random() < 0.5 ? "heads" : "tails";
        const won    = msg.choice === coin;
        const winSid = won ? client.sessionId : this.opponentOf(client.sessionId);
        const winner = this.state.players.get(winSid)!;

        this.state.tossWinner = winSid;
        this.state.phase      = "toss_decision";
        this.broadcast("toss_result", {
            coinResult: coin, callerCall: msg.choice,
            winnerId: winner.playerId, winnerName: winner.name,
            message: `${winner.name} won the toss!`,
        });
    }



    private handleTossBatBowl(client: Client, msg: { choice: string }) {
        if (this.state.phase !== "toss_decision") return;
        if (client.sessionId !== this.state.tossWinner) return;

        this.state.tossChoice = msg.choice;
        if (msg.choice === "bat") {
            this.battingSid = client.sessionId;
            this.bowlingSid = this.opponentOf(client.sessionId);
        } else {
            this.bowlingSid = client.sessionId;
            this.battingSid = this.opponentOf(client.sessionId);
        }

        const batter = this.state.players.get(this.battingSid)!;
        const bowler = this.state.players.get(this.bowlingSid)!;
        const winner = this.state.players.get(this.state.tossWinner)!;

        this.state.phase    = "deck_confirm";
        this.deckReadyCount = 0;
        this.broadcast("toss_decision", {
            winnerId: winner.playerId, winnerName: winner.name, choice: msg.choice,
            battingPlayerId: batter.playerId, bowlingPlayerId: bowler.playerId,
        });
    }

    // ── Deck Confirm ────────────────────────────────────────────────────────

    private handleDeckConfirm(client: Client, msg: { deckId: string; battingCards: any[]; bowlingCards: any[] }) {
        if (this.state.phase !== "deck_confirm") return;
        const player = this.state.players.get(client.sessionId);
        if (!player || player.ready) return;

        const bc = msg.battingCards || [];
        const bw = msg.bowlingCards || [];
        if (bc.length < 2 || bw.length < 2) {
            client.send("deck_invalid", { error: "Deck requires at least 2 batting and 2 bowling cards." });
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
    }

    private handleSelectBowler(client: Client, msg: { cardId: string }) {
        if (!this.state.awaitingBowlerSelection) return;
        this.ballTimer?.clear();
        this.bowlerCardId = msg.cardId;
        this.state.awaitingBowlerSelection = false;
        const bSid = this.currentInnings === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInnings === 1 ? this.bowlingSid : this.battingSid;
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
    }

    private handleSelectBatsman(client: Client, msg: { cardId: string }) {
        if (this.state.awaitingBowlerSelection) return;
        this.ballTimer?.clear();
        this.batsmanCardId = msg.cardId;
        const bSid = this.currentInnings === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInnings === 1 ? this.bowlingSid : this.battingSid;
        this.startBall(bSid, wSid);
    }

    private startBall(battingSid: string, bowlingSid: string) {
        const innings    = this.activeInnings();
        const ballNumber = innings.ballsBowled + 1;
        const over       = innings.currentOver;
        const ballInOver = innings.ballsBowled % this.state.ballsPerOver;

        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingCards?.find((c: DeckCard) => c.cardId === this.bowlerCardId);
        const bowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";
        const speed      = this.state.currentBallArrowSpeed;

        this.state.awaitingBatsmanTap = true;
        this.broadcast("ball_start", {
            ballNumber, over, ballInOver, arrowSpeed: speed,
            timeoutSeconds: BALL_TIMEOUT_MS / 1000,
            bowlerCardId: this.bowlerCardId, bowlerType,
        });
        this.ballTimer = this.clock.setTimeout(() => {
            if (this.state.awaitingBatsmanTap) this.resolveBall(0.0, battingSid, bowlingSid);
        }, BALL_TIMEOUT_MS);
    }

    private handleBatsmanTap(client: Client, msg: { position: number }) {
        if (!this.state.awaitingBatsmanTap) return;
        this.ballTimer?.clear();
        this.state.awaitingBatsmanTap = false;
        const bSid = this.currentInnings === 1 ? this.battingSid : this.bowlingSid;
        const wSid = this.currentInnings === 1 ? this.bowlingSid : this.battingSid;
        this.resolveBall(msg.position, bSid, wSid);
    }

    // ── Ball Resolution ──────────────────────────────────────────────────────

    private resolveBall(position: number, battingSid: string, bowlingSid: string) {
        const innings = this.activeInnings();
        const zone    = Math.min(Math.floor(position / (1.0 / SLIDER_VALUES.length)), SLIDER_VALUES.length - 1);
        const value   = SLIDER_VALUES[zone];

        let outcome = "dot", runs = 0;
        if (value === -1) { outcome = "wicket"; innings.wickets++; }
        else if (value > 0) { outcome = "run"; runs = value; innings.score += runs; }

        innings.ballsBowled++;
        if (innings.ballsBowled % this.state.ballsPerOver === 0) innings.currentOver++;

        const ball          = new BallState();
        ball.ballNumber     = innings.ballsBowled;
        ball.outcome        = outcome;
        ball.runs           = runs;
        ball.originalRuns   = runs;
        ball.bowlerCardId   = this.bowlerCardId;
        ball.batsmanCardId  = this.batsmanCardId;
        ball.sliderPosition = Math.round(position * 100);
        ball.arrowSpeed     = this.state.currentBallArrowSpeed;
        innings.balls.push(ball);

        const bowlerCard = this.state.players.get(bowlingSid)?.bowlingCards?.find((c: DeckCard) => c.cardId === this.bowlerCardId);
        const bowlerType = bowlerCard?.role?.includes("Spin") ? "spin" : "fast";

        this.broadcast("ball_result", {
            ballNumber: ball.ballNumber, outcome, runs, originalRuns: runs,
            score: innings.score, wickets: innings.wickets,
            ballsBowled: innings.ballsBowled, currentOver: innings.currentOver,
            bowlerType, powerUsed: "", arrowSpeed: this.state.currentBallArrowSpeed,
        });

        const maxBalls = this.state.oversPerMatch * this.state.ballsPerOver;
        if (this.currentInnings === 2 && innings.target > 0 && innings.score >= innings.target) {
            this.endInnings(); return;
        }
        if (innings.ballsBowled >= maxBalls || innings.wickets >= this.state.maxWickets) {
            this.endInnings();
        } else {
            const nb = this.currentInnings === 1 ? this.battingSid : this.bowlingSid;
            const nw = this.currentInnings === 1 ? this.bowlingSid : this.battingSid;
            this.clock.setTimeout(() => this.promptBowlerCard(nb, nw), 1000);
        }
    }

    // ── Innings / Match End ──────────────────────────────────────────────────

    private endInnings() {
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
        if (s1 === s2) { this.endMatch("", "", "draw"); return; }

        // In innings 2 the roles swap: bowlingSid is now batting
        const chaseSid   = this.bowlingSid;
        const defendSid  = this.battingSid;
        if (s2 > s1) this.endMatch(chaseSid,  defendSid, "chase");
        else         this.endMatch(defendSid, chaseSid,  "defended");
    }

    private endMatch(winSid: string, loseSid: string, reason: string) {
        this.state.phase     = "result";
        this.state.winReason = reason;
        this.state.eloDelta  = ELO_DELTA;
        const winner = winSid  ? this.state.players.get(winSid)  : null;
        const loser  = loseSid ? this.state.players.get(loseSid) : null;
        this.state.winner = winner?.playerId || "";

        this.broadcast("match_end", {
            winnerId:   winner?.playerId || "", winnerName: winner?.name || "",
            loserId:    loser?.playerId  || "", loserName:  loser?.name  || "",
            reason, eloDelta: ELO_DELTA,
        });
        this.clock.setTimeout(() => this.disconnect(), 5000);
    }

    // ── Powers / Forfeit ────────────────────────────────────────────────────

    private handlePowerActivate(client: Client, msg: { powerId: string; cardId: string }) {
        const p = this.state.players.get(client.sessionId);
        this.broadcast("power_applied", {
            playerId: p?.playerId, powerId: msg.powerId,
            cardId: msg.cardId, usesRemaining: 0, effect: "applied",
        });
    }

    private handleForfeit(client: Client) {
        this.endMatch(this.opponentOf(client.sessionId), client.sessionId, "forfeit");
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private opponentOf(sid: string): string {
        return this.clients.find(c => c.sessionId !== sid)?.sessionId || "";
    }

    private activeInnings(): InningsData {
        return this.currentInnings === 1 ? this.state.innings1 : this.state.innings2;
    }
}
