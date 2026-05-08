# Power Cricket — Server (Colyseus)

Parent: [repo root](../CLAUDE.md)

Colyseus 0.17.x game server (Node.js / TypeScript) running on Colyseus Cloud (Mumbai region). Hosts match rooms, lobby, REST endpoints, Express monitor.

## Server Overview

```
PowerCricketServer/
├── src/
│   ├── index.ts                # Entry point (port 2567)
│   ├── app.config.ts           # Room definitions, Express routes, monitor
│   └── rooms/
│       ├── MyRoom.ts           # Room handler template (max 4 clients)
│       └── schema/
│           └── MyRoomState.ts  # State schema (@colyseus/schema)
├── test/                       # Mocha test suite
├── loadtest/                   # Load testing scripts
├── package.json                # Node >= 20.9.0
├── tsconfig.json               # ESNext, strict, experimental decorators
└── ecosystem.config.cjs        # PM2 production config
```

## Build & Run Commands

```bash
npm install              # Install dependencies
npm start                # Dev server with hot reload (tsx watch, port 2567)
npm run build            # Compile TypeScript → build/
npm test                 # Run Mocha test suite (15s timeout)
npm run loadtest         # Load test with 2 concurrent clients
```

## TypeScript Conventions

- **Target:** ESNext with NodeNext modules
- **Strict mode:** Enabled (but `strictNullChecks: false`)
- **Decorators:** Experimental decorators enabled for `@type()` schema annotations
- **State sync:** Use `@colyseus/schema` binary serialization, not raw JSON

## Server Authority Scope

Match outcomes (runs / wickets / innings transitions / match result) are server-authoritative. **Per-ball pattern generation is bowler-client-authoritative** — the server is a pass-through relay for patterns. `MatchRoom.ts` does NOT import `PatternGenerator` or apply powers, except for the documented `buildInitialPattern` fallback path used when the bowler client times out or is a bot. Re-introducing server-side power application forks the pipeline and silently diverges from the bowler-device result.

Detailed per-ball flow: [Match Rule #9](../POWERC/Assets/Scripts/Match/CLAUDE.md#9-per-ball-pattern-authority-bowler-client-authoritative).

## Critical Engineering Rules — Server Side

The serialization rules and message-design rules that govern this server live in the client's [Network module CLAUDE.md](../POWERC/Assets/Scripts/Network/CLAUDE.md):

- [Rule #1: JS ↔ C# Serialization](../POWERC/Assets/Scripts/Network/CLAUDE.md#1-js--c-serialization-never-trust-numeric-ranges) — JS bitwise ops truncate to signed 32-bit; always use `>>> 0` for unsigned. `Date.now()` will overflow.
- [Rule #2: Server→Client Per-Player Messages](../POWERC/Assets/Scripts/Network/CLAUDE.md#2-serverclient-per-player-messages-identification-pattern) — use `client.send()` for per-player content, not `broadcast()`. Identify by sentinel value or explicit role field.
- [Rule #5: Server Deployment Checklist](../POWERC/Assets/Scripts/Network/CLAUDE.md#5-server-deployment-checklist) — pre-deploy checks for `Date.now()` usages, `client.send()` vs `broadcast()`, sentinel values, server restart, deployed-commit verification.
- [Rule #6: Adding New Server→Client Messages](../POWERC/Assets/Scripts/Network/CLAUDE.md#6-adding-new-serverclient-messages) — define payload shape in server comment, mirror in C# DTO, log both sides.

## Sensitive Files — Do Not Commit

- `.env.*` — Environment variables
- `serviceAccountKey.json` / `*-firebase-adminsdk-*.json` — Firebase admin credentials
- `../SErverdetails/` — Colyseus Cloud login, SSH private keys (.pem, .ppk)

---

## References

- [`DeployeInstruction.md`](DeployeInstruction.md) — Server deployment/build instructions
- [`GAME_CONFIG_SETUP.md`](GAME_CONFIG_SETUP.md) — Firestore game config setup and refresh
- [`../COLYSEUS_SETUP_SUMMARY.md`](../COLYSEUS_SETUP_SUMMARY.md) — Colyseus SDK integration status & architecture
- [`../Server_Deployment.md`](../Server_Deployment.md) — Server deployment guide
- [`../Network_Solution_Strategy.md`](../Network_Solution_Strategy.md) — Network architecture strategy
- [`../CLIENT_SERVER_WIRING.md`](../CLIENT_SERVER_WIRING.md) — Client-server integration guide
- [Client Network module](../POWERC/Assets/Scripts/Network/CLAUDE.md) — All serialization rules + message design checklist
