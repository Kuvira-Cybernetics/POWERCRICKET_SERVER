import { Room, Client, matchMaker, Delayed } from "colyseus";
import { LobbyRoomState } from "./schema/LobbyRoomState.js";
import { onlinePlayers } from "../presence.js";
import { getGameConfig } from "../config/gameConfig.js";

// ── ELO Matchmaking Constants ──────────────────────────────────────────────
const ELO_BRACKET_INITIAL  = 200;   // ±200 ELO at start
const ELO_BRACKET_EXPANDED = 400;   // ±400 after EXPAND_AFTER_MS
const EXPAND_AFTER_MS      = 15_000;
const BOT_INJECT_AFTER_MS  = 5_000;  // inject bot after 5s
const MATCHMAKING_TICK_MS  = 2_000;  // run matching every 2s

interface QueueEntry {
    client:           Client;
    teamId:           string;
    jwtToken:         string;
    gameMode:         string;
    elo:              number;
    joinedAt:         number;
    matched:          boolean;
    timeoutNotified:  boolean;  // true once we've sent matchmaking_timeout to the client
}

// Private room waiting for a second player
interface PrivateRoom {
    roomCode:  string;
    host:      QueueEntry;
    overs:     number;
    createdAt: number;
}

/**
 * LobbyRoom — room name "lobby"
 * Holds the matchmaking queue with ELO-bracket filtering.
 * Bracket expands over time: ±200 → ±400 (15s) → anyone (30s).
 * After 30s with no match, injects a bot opponent.
 */
export class LobbyRoom extends Room {
    declare state: LobbyRoomState;
    maxClients = 200;

    private queue: QueueEntry[] = [];
    private privateRooms: Map<string, PrivateRoom> = new Map();
    private matchmakingTimer: Delayed | null = null;

    onCreate(options: any) {
        this.state = new LobbyRoomState();

        this.onMessage("cancel_matchmaking", (client) => {
            this.removeFromQueue(client.sessionId);
            this.removePrivateRoom(client.sessionId);
            this.updateWaitingCount();
            client.send("matchmaking_update", { status: "cancelled" });
        });

        // Player explicitly requested a bot match after timeout prompt
        this.onMessage("request_bot_match", async (client) => {
            const entry = this.queue.find(e => e.client.sessionId === client.sessionId && !e.matched);
            if (!entry) {
                client.send("matchmaking_update", { status: "cancelled" });
                return;
            }
            entry.matched = true;
            this.updateWaitingCount();
            await this.createBotMatch(entry);
        });

        this.onMessage("get_elo_bracket", (client) => {
            const entry = this.queue.find(e => e.client.sessionId === client.sessionId);
            const elo   = entry?.elo ?? 1000;
            const bracket = this.eloBracketName(elo);
            const range   = this.eloRange(entry);
            client.send("elo_bracket_info", {
                bracket, elo, minElo: elo - range, maxElo: elo + range,
            });
        });

        // Private room: create
        this.onMessage("create_private_room", (client, data) => {
            const entry = this.queue.find(e => e.client.sessionId === client.sessionId);
            if (!entry) return;

            const roomCode = this.generateRoomCode();
            const overs = Math.min(Math.max(data?.overs || 3, 2), 5);

            this.privateRooms.set(roomCode, {
                roomCode,
                host: entry,
                overs,
                createdAt: Date.now(),
            });
            entry.matched = true; // Don't match in public queue

            client.send("private_room_created", { roomCode, overs });
            console.log(`[LobbyRoom] Private room created: ${roomCode} (${overs} overs)`);
        });

        // Private room: join by code
        this.onMessage("join_private_room", (client, data) => {
            const entry = this.queue.find(e => e.client.sessionId === client.sessionId);
            if (!entry) return;

            const roomCode = data?.roomCode;
            const privateRoom = this.privateRooms.get(roomCode);

            if (!privateRoom) {
                client.send("private_room_error", { error: "Room not found or expired" });
                return;
            }

            entry.matched = true;
            this.privateRooms.delete(roomCode);
            this.createPrivateMatch(privateRoom.host, entry, privateRoom.overs);
        });

        // Periodic matchmaking tick — tries to match all waiting players
        this.matchmakingTimer = this.clock.setInterval(() => {
            this.tryMatchAll();
        }, MATCHMAKING_TICK_MS);
    }

    onJoin(client: Client, options: any) {
        const entry: QueueEntry = {
            client,
            teamId:          options.teamId || options.deckId || "",
            jwtToken:        options.jwtToken || "",
            gameMode:        options.gameMode || "casual",
            elo:             options.elo      || 1000,
            joinedAt:        Date.now(),
            matched:         false,
            timeoutNotified: false,
        };

        // Mark player as online (keyed by their JWT / userId)
        const userId = entry.jwtToken || client.sessionId;
        onlinePlayers.add(userId);

        this.queue.push(entry);
        this.updateWaitingCount();
        client.send("matchmaking_update", { status: "searching" });

        // Immediate attempt on join
        this.tryMatchAll();
    }

    onLeave(client: Client, code?: number) {
        const entry = this.queue.find(e => e.client.sessionId === client.sessionId);
        if (entry) {
            const userId = entry.jwtToken || client.sessionId;
            onlinePlayers.delete(userId);
        }
        this.removeFromQueue(client.sessionId);
        this.updateWaitingCount();
    }

    onDispose() {
        this.matchmakingTimer?.clear();
        console.log("[LobbyRoom] disposed");
    }

    // ── ELO Helpers ──────────────────────────────────────────────────────────

    /** Returns allowed ELO range for a queue entry based on wait time. */
    private eloRange(entry: QueueEntry | undefined): number {
        if (!entry) return 9999;
        const waited = Date.now() - entry.joinedAt;
        if (waited >= BOT_INJECT_AFTER_MS) return 9999; // match with anyone
        if (waited >= EXPAND_AFTER_MS)     return ELO_BRACKET_EXPANDED;
        return ELO_BRACKET_INITIAL;
    }

    /** Checks if two players are within each other's ELO bracket. */
    private isEloCompatible(a: QueueEntry, b: QueueEntry): boolean {
        const rangeA = this.eloRange(a);
        const rangeB = this.eloRange(b);
        const diff   = Math.abs(a.elo - b.elo);
        return diff <= Math.max(rangeA, rangeB);
    }

    /** Human-readable bracket name for client display. */
    private eloBracketName(elo: number): string {
        if (elo < 800)  return "bronze";
        if (elo < 1200) return "silver";
        if (elo < 1600) return "gold";
        if (elo < 2000) return "platinum";
        return "diamond";
    }

    // ── Matchmaking Logic ───────────────────────────────────────────────────

    private async tryMatchAll() {
        const waiting = this.queue.filter(e => !e.matched);
        if (waiting.length < 2) {
            // Check for bot injection for lonely players
            this.checkBotInjection(waiting);
            return;
        }

        // Sort by join time (oldest first) for fairness
        waiting.sort((a, b) => a.joinedAt - b.joinedAt);

        const matched = new Set<string>();

        for (let i = 0; i < waiting.length; i++) {
            if (matched.has(waiting[i].client.sessionId)) continue;

            let bestMatch: QueueEntry | null = null;
            let bestDiff  = Infinity;

            for (let j = i + 1; j < waiting.length; j++) {
                if (matched.has(waiting[j].client.sessionId)) continue;
                if (!this.isEloCompatible(waiting[i], waiting[j])) continue;

                const diff = Math.abs(waiting[i].elo - waiting[j].elo);
                if (diff < bestDiff) {
                    bestDiff  = diff;
                    bestMatch = waiting[j];
                }
            }

            if (bestMatch) {
                matched.add(waiting[i].client.sessionId);
                matched.add(bestMatch.client.sessionId);
                await this.createMatch(waiting[i], bestMatch);
            }
        }

        // After pairing, check remaining solo players for bot injection
        const stillWaiting = this.queue.filter(e => !e.matched);
        this.checkBotInjection(stillWaiting);
    }

    /**
     * Notifies players who have waited past BOT_INJECT_AFTER_MS that no human was found.
     * The client will show a "Play with Bot" button — bot injection only happens on
     * explicit request via the "request_bot_match" message.
     */
    private checkBotInjection(waiting: QueueEntry[]) {
        const now = Date.now();
        for (const entry of waiting) {
            if (entry.matched || entry.timeoutNotified) continue;
            if (now - entry.joinedAt >= BOT_INJECT_AFTER_MS) {
                entry.timeoutNotified = true;
                entry.client.send("matchmaking_timeout", { waitedMs: now - entry.joinedAt });
                console.log(`[LobbyRoom] Timeout notified (no auto-bot): ${entry.client.sessionId}`);
            }
        }
    }

    private async createMatch(p1: QueueEntry, p2: QueueEntry) {
        p1.matched = true;
        p2.matched = true;
        this.updateWaitingCount();

        try {
            const cfg = getGameConfig();
            const room = await matchMaker.createRoom("match_room", {
                matchId:             `match_${Date.now()}`,
                oversPerMatch:       cfg.oversPerMatch,
                ballsPerOver:        cfg.ballsPerOver,
                maxWickets:          cfg.maxWickets,
                superOverEnabled:    cfg.superOverEnabled,
                botCatchRate:        cfg.botCatchRate,
                botWicketZoneFactor: cfg.botWicketZoneFactor,
            });

            const p1Opponent = JSON.stringify({ sessionId: p2.client.sessionId, teamId: p2.teamId, elo: p2.elo });
            const p2Opponent = JSON.stringify({ sessionId: p1.client.sessionId, teamId: p1.teamId, elo: p1.elo });

            p1.client.send("match_found", { matchId: room.roomId, opponent: p1Opponent });
            p2.client.send("match_found", { matchId: room.roomId, opponent: p2Opponent });

            console.log(`[LobbyRoom] ELO match: ${p1.elo} vs ${p2.elo} (diff=${Math.abs(p1.elo - p2.elo)}) → ${room.roomId}`);
        } catch (err) {
            console.error("[LobbyRoom] Failed to create MatchRoom:", err);
            p1.matched = false;
            p2.matched = false;
            this.updateWaitingCount();
        }
    }

    private async createBotMatch(entry: QueueEntry) {
        try {
            const cfg = getGameConfig();
            const room = await matchMaker.createRoom("match_room", {
                matchId:             `match_bot_${Date.now()}`,
                oversPerMatch:       cfg.oversPerMatch,
                ballsPerOver:        cfg.ballsPerOver,
                maxWickets:          cfg.maxWickets,
                superOverEnabled:    cfg.superOverEnabled,
                isBot:               true,
                botCatchRate:        cfg.botCatchRate,
                botWicketZoneFactor: cfg.botWicketZoneFactor,
            });

            const botNames = ["Tendulkar","Kohli","Dhoni","Warner","Root","Babar","Stokes","Bumrah","Rashid","Starc"];
            const botOpponent = JSON.stringify({
                sessionId: "bot",
                teamId: "bot_team",
                elo: entry.elo,
                isBot: true,
                botName: `bot_${botNames[Math.floor(Math.random() * botNames.length)]}`,
            });

            entry.client.send("match_found", { matchId: room.roomId, opponent: botOpponent, isBot: true });
            console.log(`[LobbyRoom] Bot injected for ${entry.client.sessionId} (elo=${entry.elo}) → ${room.roomId}`);
        } catch (err) {
            console.error("[LobbyRoom] Failed to create bot MatchRoom:", err);
            entry.matched = false;
            this.updateWaitingCount();
        }
    }

    // ── Private Match ────────────────────────────────────────────────────────

    private async createPrivateMatch(host: QueueEntry, guest: QueueEntry, overs: number) {
        try {
            const cfg = getGameConfig();
            const room = await matchMaker.createRoom("match_room", {
                matchId:             `match_private_${Date.now()}`,
                oversPerMatch:       overs,                    // host-chosen override
                ballsPerOver:        cfg.ballsPerOver,
                maxWickets:          cfg.maxWickets,
                superOverEnabled:    cfg.superOverEnabled,
                botCatchRate:        cfg.botCatchRate,
                botWicketZoneFactor: cfg.botWicketZoneFactor,
            });

            const hostOpponent = JSON.stringify({ sessionId: guest.client.sessionId, teamId: guest.teamId, elo: guest.elo });
            const guestOpponent = JSON.stringify({ sessionId: host.client.sessionId, teamId: host.teamId, elo: host.elo });

            host.client.send("match_found", { matchId: room.roomId, opponent: hostOpponent });
            guest.client.send("match_found", { matchId: room.roomId, opponent: guestOpponent });

            console.log(`[LobbyRoom] Private match: ${host.elo} vs ${guest.elo} (${overs} overs) → ${room.roomId}`);
        } catch (err) {
            console.error("[LobbyRoom] Failed to create private MatchRoom:", err);
            host.matched = false;
            guest.matched = false;
            this.updateWaitingCount();
        }
    }

    private generateRoomCode(): string {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I/O/0/1 to avoid confusion
        let code = "";
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    private removePrivateRoom(sessionId: string) {
        for (const [code, room] of this.privateRooms) {
            if (room.host.client.sessionId === sessionId) {
                this.privateRooms.delete(code);
                break;
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private removeFromQueue(sessionId: string) {
        this.queue = this.queue.filter(e => e.client.sessionId !== sessionId);
    }

    private updateWaitingCount() {
        this.state.playersWaiting = this.queue.filter(e => !e.matched).length;

        // Update average wait time
        const waiting = this.queue.filter(e => !e.matched);
        if (waiting.length > 0) {
            const now = Date.now();
            const totalWait = waiting.reduce((sum, e) => sum + (now - e.joinedAt), 0);
            this.state.averageWaitTimeSeconds = (totalWait / waiting.length) / 1000;
        } else {
            this.state.averageWaitTimeSeconds = 0;
        }
    }
}

