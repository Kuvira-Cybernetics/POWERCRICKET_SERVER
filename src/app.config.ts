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
         * Use @colyseus/monitor
         * It is recommended to protect this route with a password
         * Read more: https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        app.use("/monitor", monitor());

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