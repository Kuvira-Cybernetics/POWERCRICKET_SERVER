import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { LobbyRoom }  from "./rooms/LobbyRoom.js";
import { MatchRoom }  from "./rooms/MatchRoom.js";
import express from "express";
import { registerApiRoutes } from "./routes/api.js";
import { initFirebaseAdmin } from "./config/firebaseAdmin.js";
import { initGameConfig }    from "./config/gameConfig.js";
import { loadPowerDefinitions } from "./rooms/powers/loader.js";
import { initBotTeamBuilder }  from "./rooms/bots/BotTeamBuilder.js";
import { initBotProfileLoader } from "./rooms/bots/BotProfileLoader.js";
import { monitorAuth }         from "./middleware/monitor-auth.js";

// ── Boot-time config load ─────────────────────────────────────────────────
// Initialize Firebase Admin, then load game config + power definitions.
// Non-blocking: rooms may briefly use defaults during the first few seconds
// after startup until the initial Firestore fetch completes.
const _db = initFirebaseAdmin();
initGameConfig(_db).catch(err =>
    console.warn("[app.config] initGameConfig failed:", err));
loadPowerDefinitions(_db).catch(err =>
    console.warn("[app.config] loadPowerDefinitions failed:", err));
initBotTeamBuilder().catch(err =>
    console.warn("[app.config] initBotTeamBuilder failed:", err));
initBotProfileLoader().catch(err =>
    console.warn("[app.config] initBotProfileLoader failed:", err));

const server = defineServer({
    // Increase max WebSocket payload from 4KB default to 16KB
    // Required for @colyseus/webrtc SDP exchange messages
    transport: new WebSocketTransport({ maxPayload: 16 * 1024 }),
    /**
     * Room handlers:
     *   "lobby"      — matchmaking queue (ColyseusLobbyHandler.cs)
     *   "match_room" — 1v1 cricket match  (ColyseusMatchHandler.cs)
     */
    rooms: {
        lobby:      defineRoom(LobbyRoom),
        match_room: defineRoom(MatchRoom),
    },

    /**
     * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
     * 
     * Usage from SDK: 
     *   client.http.get("/api/hello").then((response) => {})
     * 
     */
    routes: createRouter({
        api_hello: createEndpoint("/api/hello", { method: "GET", }, async (ctx) => {
            return { message: "Hello World" }
        })
    }),

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        // JSON body parsing
        app.use(express.json());

        // Register all REST API endpoints
        registerApiRoutes(app);

        app.get("/hi", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        /**
         * Build-version probe. Returns the BUILD_SHA env var (set during deploy)
         * plus a startedAt timestamp so you can verify Colyseus Cloud is running
         * the commit you think it is. Per CLAUDE.md rule #5: deployed commit
         * MUST match git HEAD before declaring a server fix shipped.
         *
         * Usage:
         *   curl https://<your-cloud-host>/health
         *   → { sha: "cda4549", startedAt: "2026-05-10T...", uptime: 1234 }
         *
         * To populate BUILD_SHA on Colyseus Cloud, add this to your deploy step:
         *   BUILD_SHA=$(git rev-parse --short HEAD) colyseus-cloud deploy
         */
        const buildSha    = process.env.BUILD_SHA || "unknown";
        const startedAt   = new Date().toISOString();
        app.get("/health", (_req, res) => {
            res.json({ sha: buildSha, startedAt, uptime: Math.floor(process.uptime()) });
        });

        /**
         * Use @colyseus/monitor
         * Guarded by HTTP Basic Auth in production (MONITOR_USER / MONITOR_PASS env vars).
         * Dev environments mount it unauthenticated so playground iteration stays fast.
         */
        if (process.env.NODE_ENV === "production") {
            app.use("/monitor", monitorAuth(), monitor());
        } else {
            app.use("/monitor", monitor());
        }

        /**
         * Use @colyseus/playground
         * (It is not recommended to expose this route in a production environment)
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;