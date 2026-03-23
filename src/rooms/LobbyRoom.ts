import { Room, Client, matchMaker } from "colyseus";
import { LobbyRoomState } from "./schema/LobbyRoomState.js";

interface QueueEntry {
    client:    Client;
    deckId:    string;
    jwtToken:  string;
    gameMode:  string;
    joinedAt:  number;
    matched:   boolean;
}

/**
 * LobbyRoom — room name "lobby"
 * Holds the matchmaking queue. When 2 players are ready, creates a MatchRoom
 * and sends match_found to both clients so they can JoinById.
 */
export class LobbyRoom extends Room {
    declare state: LobbyRoomState;
    maxClients = 200;

    private queue: QueueEntry[] = [];

    onCreate(options: any) {
        this.state = new LobbyRoomState();

        this.onMessage("cancel_matchmaking", (client) => {
            this.removeFromQueue(client.sessionId);
            this.updateWaitingCount();
            client.send("matchmaking_update", { status: "cancelled" });
        });

        this.onMessage("get_elo_bracket", (client) => {
            // Placeholder — will integrate Firebase ELO later
            client.send("elo_bracket_info", { bracket: "bronze", minElo: 0, maxElo: 1199 });
        });
    }

    onJoin(client: Client, options: any) {
        const entry: QueueEntry = {
            client,
            deckId:   options.deckId   || "",
            jwtToken: options.jwtToken || "",
            gameMode: options.gameMode || "casual",
            joinedAt: Date.now(),
            matched:  false,
        };

        this.queue.push(entry);
        this.updateWaitingCount();
        client.send("matchmaking_update", { status: "searching" });

        // Try to match whenever a new player joins
        this.tryMatch();
    }

    onLeave(client: Client, code?: number) {
        this.removeFromQueue(client.sessionId);
        this.updateWaitingCount();
    }

    onDispose() {
        console.log("[LobbyRoom] disposed");
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    private async tryMatch() {
        const waiting = this.queue.filter(e => !e.matched);
        if (waiting.length < 2) return;

        const p1 = waiting[0];
        const p2 = waiting[1];

        // Mark as matched immediately so concurrent joins don't double-match them
        p1.matched = true;
        p2.matched = true;
        this.updateWaitingCount();

        try {
            // Create the MatchRoom — clients will join it by the returned roomId
            const room = await matchMaker.createRoom("match_room", {
                matchId:      `match_${Date.now()}`,
                oversPerMatch: 3,
                ballsPerOver:  6,
            });

            const p1Opponent = JSON.stringify({ sessionId: p2.client.sessionId, deckId: p2.deckId });
            const p2Opponent = JSON.stringify({ sessionId: p1.client.sessionId, deckId: p1.deckId });

            p1.client.send("match_found", { matchId: room.roomId, opponent: p1Opponent });
            p2.client.send("match_found", { matchId: room.roomId, opponent: p2Opponent });

            console.log(`[LobbyRoom] Matched ${p1.client.sessionId} vs ${p2.client.sessionId} → room ${room.roomId}`);
        } catch (err) {
            console.error("[LobbyRoom] Failed to create MatchRoom:", err);
            // Un-mark so they stay in queue
            p1.matched = false;
            p2.matched = false;
            this.updateWaitingCount();
        }
    }

    private removeFromQueue(sessionId: string) {
        this.queue = this.queue.filter(e => e.client.sessionId !== sessionId);
    }

    private updateWaitingCount() {
        this.state.playersWaiting = this.queue.filter(e => !e.matched).length;
    }
}

