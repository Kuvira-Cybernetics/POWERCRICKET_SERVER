# Power Cricket Server — Colyseus Cloud Deployment Guide

**Version:** 1.0
**Last Updated:** March 22, 2026
**Server:** Colyseus 0.17.x on Node.js 20+
**Target Region:** Mumbai (ap-south-1)

---

## Table of Contents

1. Prerequisites
2. Local Development Setup
3. Server Architecture Overview
4. Colyseus Cloud Account Setup
5. Preparing for Deployment
6. Deploying to Colyseus Cloud
7. Environment Configuration
8. Room Configuration Reference
9. WebSocket Message Protocol
10. REST API Endpoints
11. Monitoring & Debugging
12. Scaling & Performance
13. Updating the Server
14. Troubleshooting
15. Unity Client Connection Guide

---

## 1. Prerequisites

Before deploying, ensure you have the following installed locally:

- **Node.js** >= 20.9.0 (check with `node -v`)
- **npm** >= 10.x (check with `npm -v`)
- **Git** (for pushing to the deployment repo)
- **Colyseus Cloud account** at https://cloud.colyseus.io

The server repository is at: `https://github.com/Kuvira-Cybernetics/POWERCRICKET_SERVER.git`

---

## 2. Local Development Setup

Clone and run the server locally first to verify everything works:

```bash
# Clone the repository
git clone https://github.com/Kuvira-Cybernetics/POWERCRICKET_SERVER.git
cd POWERCRICKET_SERVER

# Install dependencies
npm install

# Start development server (hot reload)
npm start
```

The server starts on port **2567** by default. You should see:

```
[MyRoom <roomId>] Created | overs=3 private=false code=
```

Verify it's running:

```bash
# Health check
curl http://localhost:2567/api/health

# Expected response:
# {"status":"ok","uptime":5.123,"timestamp":1711100000000,"version":"1.0.0"}
```

Development tools available at:

- **Colyseus Playground:** http://localhost:2567/ (interactive room testing)
- **Colyseus Monitor:** http://localhost:2567/monitor (room inspection)

---

## 3. Server Architecture Overview

The server has two main components:

### Real-Time Match Rooms (WebSocket)

Three room types are registered, all using the same `MyRoom` handler:

| Room Name | Purpose | Max Clients |
|-----------|---------|-------------|
| `cricket_match` | Public ranked matches | 2 |
| `private_match` | Private friend matches (with room code) | 2 |
| `my_room` | Legacy alias (backward compat) | 2 |

### REST API (Express)

21 HTTP endpoints across 8 categories: Auth, Profile, Cards, Store, Matchmaking, Social, Leaderboard, and Deck Validation. All REST endpoints use in-memory mock data stores — they are functional for development and testing but should be backed by Firebase/Firestore for production.

### Match Flow

```
lobby → toss → toss_choice → deck_confirm → innings1 → innings_break → innings2 → result
                                                                              ↓
                                                                    (if tied) super_over_1 → super_over_2 → result
```

---

## 4. Colyseus Cloud Account Setup

### Step 1: Create an Account

1. Go to https://cloud.colyseus.io
2. Sign up with GitHub or email
3. Verify your email

### Step 2: Create an Application

1. From the Colyseus Cloud dashboard, click **"Create Application"**
2. Fill in:
   - **Application Name:** `power-cricket` (or your preferred name)
   - **Region:** Select **Mumbai (ap-south-1)** for lowest latency to Indian players
   - **Plan:** Choose your tier (Free tier supports up to 20 CCU for testing)
3. Click **Create**

### Step 3: Link Your GitHub Repository

1. In the application settings, go to **"Deployments"**
2. Click **"Connect GitHub Repository"**
3. Authorize Colyseus Cloud to access your GitHub
4. Select the repository: `Kuvira-Cybernetics/POWERCRICKET_SERVER`
5. Select the branch: `main`

---

## 5. Preparing for Deployment

### Verify package.json Scripts

Colyseus Cloud uses these npm scripts during deployment:

```json
{
  "scripts": {
    "build": "npm run clean && tsc -p tsconfig.build.json",
    "start": "tsx watch src/index.ts",
    "clean": "rimraf build"
  }
}
```

Colyseus Cloud will run `npm run build` during deployment and then start the compiled output from `build/index.js`.

### Verify Entry Point

The `ecosystem.config.cjs` file tells PM2 (used by Colyseus Cloud in production) how to run the server:

```javascript
const os = require("os");
module.exports = {
    apps: [{
        name: "power-cricket-server",
        script: "build/index.js",
        instances: os.cpus().length,
        exec_mode: "fork",
        watch: false,
    }]
};
```

### Ensure Build Succeeds Locally

```bash
# Clean build
npm run build

# Verify output exists
ls build/
# Should show: index.js, app.config.js, rooms/
```

### Push Latest Code

Make sure your latest code is pushed to the `main` branch:

```bash
git add .
git commit -m "Ready for deployment"
git push origin main
```

---

## 6. Deploying to Colyseus Cloud

### Option A: Auto-Deploy from GitHub (Recommended)

If you linked your GitHub repository in Step 4.3, Colyseus Cloud can auto-deploy on every push to `main`:

1. Go to your application in the Colyseus Cloud dashboard
2. Navigate to **"Deployments" → "Settings"**
3. Enable **"Auto-deploy on push"**
4. Every `git push origin main` will trigger a new deployment

### Option B: Manual Deploy via Dashboard

1. Go to **"Deployments"** in the Colyseus Cloud dashboard
2. Click **"Deploy"**
3. Select the branch (`main`) and commit
4. Click **"Deploy Now"**
5. Watch the build logs in real-time

### Option C: Deploy via CLI

Install the Colyseus Cloud CLI:

```bash
npm install -g @colyseus/cloud
```

Login and deploy:

```bash
# Login to Colyseus Cloud
npx colyseus-cloud login

# Deploy from the project directory
cd PowerCricketServer
npx colyseus-cloud deploy
```

### Verify Deployment

After deployment completes (usually 1-3 minutes):

1. The dashboard shows **"Running"** status with a green indicator
2. Your server URL will be displayed, e.g.:
   ```
   wss://power-cricket-xxxxxx.colyseus.cloud
   ```
3. Test the health endpoint:
   ```bash
   curl https://power-cricket-xxxxxx.colyseus.cloud/api/health
   ```

---

## 7. Environment Configuration

### Setting Environment Variables

In the Colyseus Cloud dashboard, go to **"Settings" → "Environment Variables"** and add:

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `production` | Disables playground, enables production optimizations |
| `MONITOR_PASSWORD` | `<your-password>` | Protects the /monitor endpoint |

### Custom Port

Colyseus Cloud assigns the port automatically via the `PORT` environment variable. The server's `index.ts` already uses the Colyseus tools `listen()` function which reads this automatically — no changes needed.

---

## 8. Room Configuration Reference

### Joining a Public Match

From the Unity client, connect to the Colyseus server and join a room:

```
Room: "cricket_match"
Options: {
  playerId: "<firebase-uid>",
  playerName: "Arul",
  elo: 1200,
  deckId: "deck_001",
  oversPerMatch: 3,        // optional, default 3
  ballsPerOver: 6,         // optional, default 6
  maxWickets: 10,           // optional, default 10
  superOverEnabled: true    // optional, default true
}
```

### Creating a Private Match

```
Room: "private_match"
Options: {
  playerId: "<firebase-uid>",
  playerName: "Arul",
  elo: 1200,
  isPrivate: true,
  roomCode: "ABC123",      // optional, auto-generated if omitted
  oversPerMatch: 5          // custom overs for private match
}
```

### Joining a Private Match by Code

Use the Colyseus client to filter rooms by `roomCode`:

```csharp
// Unity C# example
var rooms = await client.GetAvailableRooms("private_match");
var targetRoom = rooms.FirstOrDefault(r => r.metadata.roomCode == "ABC123");
if (targetRoom != null) {
    room = await client.JoinById(targetRoom.roomId, options);
}
```

---

## 9. WebSocket Message Protocol

### Client → Server Messages (9 types)

| Message | When | Payload |
|---------|------|---------|
| `toss_choice` | Toss phase | `{ choice: "heads" \| "tails" }` |
| `toss_bat_bowl` | After winning toss | `{ choice: "bat" \| "bowl" }` |
| `deck_confirm` | Deck confirm phase | `{ deckId, battingCards: [...], bowlingCards: [...] }` |
| `select_bowler` | Before each ball | `{ cardId: "bowl_003" }` |
| `select_batsman` | Before each ball | `{ cardId: "bat_001" }` |
| `batsman_tap` | During batting | `{ position: 0.0-1.0 }` |
| `power_activate` | Before/during ball | `{ powerId: "Double Score", cardId: "bat_005" }` |
| `forfeit` | Any time | `{}` |
| `heartbeat` | Every 5 seconds | `{}` |

### Server → Client Messages (15 types)

| Message | When | Key Fields |
|---------|------|------------|
| `player_joined` | Player enters room | playerId, playerName, elo |
| `toss_screen` | Toss begins | callerId, callerName, timeoutSeconds |
| `toss_result` | Coin flipped | coinResult, winnerId, winnerName |
| `toss_decision` | Bat/bowl chosen | winnerId, choice, battingPlayerId, bowlingPlayerId |
| `select_bowler_card` | Before each ball | ballNumber, over, ballInOver, timeoutSeconds |
| `select_batsman_card` | Before each ball | ballNumber, over, ballInOver, timeoutSeconds |
| `ball_start` | Ball in play | ballNumber, arrowSpeed, bowlerType, passiveEffects |
| `ball_result` | After tap | outcome, runs, score, wickets, powerUsed |
| `innings_start` | Innings begins | inningsNumber, battingPlayerId, target |
| `innings_end` | Innings over | score, wickets, ballsBowled |
| `innings_break` | Between innings | innings1Score, target, breakDuration |
| `super_over_start` | Tie → super over | reason, innings1Score, innings2Score |
| `match_end` | Match over | winnerId, reason, finalScore, eloDelta, rewards |
| `player_disconnected` | Opponent lost connection | playerId, graceSeconds |
| `player_reconnected` | Opponent returned | playerId |
| `heartbeat_ack` | Heartbeat response | timestamp |
| `error` | Validation failure | message |
| `reconnect_state` | After reconnecting | phase, score, wickets, target |

### Deck Card Format (for `deck_confirm`)

Each card in `battingCards` and `bowlingCards` arrays:

```json
{
  "cardId": "bat_001",
  "name": "Colour Code",
  "role": "BattingStrategy",
  "rarity": "Common",
  "powerType": "Colour Code",
  "basePower": 1.1,
  "level": 3
}
```

Deck validation rules enforced server-side: exactly 2 batting cards (BattingStrategy or BattingDefense), 2-3 bowling cards (BowlingFast or BowlingSpin), minimum 1 Fast bowler, maximum 2 Spin bowlers.

---

## 10. REST API Endpoints

Base URL: `https://power-cricket-xxxxxx.colyseus.cloud`

### Auth (4 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/refresh` | Refresh auth token |
| POST | `/api/auth/logout` | Logout |

### Profile (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profile/:userId` | Get player profile |
| PUT | `/api/profile/:userId` | Update username/avatar |
| GET | `/api/profile/:userId/stats` | Get match stats |

### Cards (4 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cards/catalog` | Get full card catalog (20 cards) |
| GET | `/api/cards/inventory/:userId` | Get player's card inventory |
| POST | `/api/cards/upgrade` | Upgrade a card level |
| POST | `/api/cards/fuse` | Fuse two duplicate cards |

### Store (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/store/items` | Get store items (gem packs + boosters) |
| POST | `/api/store/purchase` | Purchase an item |
| GET | `/api/store/history/:userId` | Get purchase history |

### Deck Validation (1 endpoint)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/deck/validate` | Validate deck composition |

### Matchmaking (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/matchmaking/find` | Enter matchmaking queue |
| DELETE | `/api/matchmaking/cancel` | Cancel matchmaking |

### Social (3 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/friends/:userId` | Get friends list |
| POST | `/api/friends/request` | Send friend request |
| DELETE | `/api/friends/:userId/:friendId` | Remove friend |

### Leaderboard (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/leaderboard/global` | Global ELO leaderboard (paginated) |
| GET | `/api/leaderboard/weekly` | Weekly trophy leaderboard |

### Utility (2 endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hello` | Server status message |
| GET | `/api/health` | Health check with uptime |

---

## 11. Monitoring & Debugging

### Colyseus Monitor

Access the monitor dashboard at:

```
https://power-cricket-xxxxxx.colyseus.cloud/monitor
```

The monitor shows: active rooms, connected clients per room, room state, and message history.

### Colyseus Cloud Dashboard Logs

In the Colyseus Cloud dashboard:

1. Go to your application
2. Click **"Logs"** in the sidebar
3. View real-time server logs (all `console.log` output)
4. Filter by severity (info, warn, error)

### Key Log Patterns to Watch

```
[MyRoom <id>] Created          → Room created successfully
[MyRoom <id>] <name> joined    → Player connected
[MyRoom <id>] Starting toss    → Match is beginning
[MyRoom <id>] Ball N: ...      → Ball-by-ball outcomes
[MyRoom <id>] Match End: ...   → Match completed with winner
[MyRoom <id>] Disposed         → Room cleaned up
```

---

## 12. Scaling & Performance

### Colyseus Cloud Scaling

Colyseus Cloud handles horizontal scaling automatically. Each room runs independently, so more concurrent matches simply means more room instances.

### Performance Characteristics

| Metric | Value |
|--------|-------|
| Memory per room | ~50-100 KB |
| Messages per ball | 3-5 (bowler select + ball start + tap + result) |
| Match duration | 2-5 minutes (2-5 overs) |
| Reconnection window | 30 seconds |
| Heartbeat interval | 5 seconds |

### Plan Selection Guide

| Colyseus Cloud Plan | CCU Limit | Best For |
|---------------------|-----------|----------|
| Free | 20 CCU | Development & testing |
| Starter | 200 CCU | Soft launch (100 concurrent matches) |
| Professional | 1000 CCU | Production launch |
| Enterprise | Custom | High-scale production |

---

## 13. Updating the Server

### Zero-Downtime Updates

Colyseus Cloud supports rolling deployments. Active matches continue on the old server version while new matches use the updated code.

### Update Process

1. Make changes locally and test:
   ```bash
   npm start          # Test with Playground
   npm run build      # Verify build
   ```

2. Push to GitHub:
   ```bash
   git add .
   git commit -m "Update: description of changes"
   git push origin main
   ```

3. If auto-deploy is enabled, the deployment triggers automatically. Otherwise, trigger manually from the dashboard.

4. Monitor the deployment logs for any errors.

### Rolling Back

In the Colyseus Cloud dashboard under **"Deployments"**, you can roll back to any previous deployment by clicking **"Redeploy"** on an older version.

---

## 14. Troubleshooting

### Common Issues

**"Cannot connect to server"**

- Verify the server URL (wss:// for WebSocket, https:// for REST)
- Check that the application is running in the Colyseus Cloud dashboard
- Ensure the Unity client is using the production URL, not localhost

**"Room not found"**

- Verify room name matches exactly: `cricket_match`, `private_match`, or `my_room`
- Check that the room is defined in `app.config.ts` under `rooms`

**"Deck invalid" error on join**

- Ensure deck has exactly 2 batting cards and 2-3 bowling cards
- At least 1 bowling card must be BowlingFast
- Maximum 2 bowling cards can be BowlingSpin
- Test with the `/api/deck/validate` endpoint first

**"Reconnection failed"**

- The 30-second reconnection window may have expired
- Check client-side reconnection logic uses the same sessionId
- Verify the room hasn't been disposed (check monitor)

**Build fails on deployment**

- Run `npm run build` locally first
- Check for TypeScript errors: `npx tsc --noEmit`
- Ensure all dependencies are in `package.json` (not just devDependencies for runtime code)

---

## 15. Unity Client Connection Guide

### Install Colyseus SDK

The Unity client should have the Colyseus SDK already installed via UPM. The key package is `io.colyseus.sdk`.

### Connection Code (C#)

```csharp
using Colyseus;

// Production URL from Colyseus Cloud dashboard
private string serverUrl = "wss://power-cricket-xxxxxx.colyseus.cloud";

// Development URL
// private string serverUrl = "ws://localhost:2567";

private ColyseusClient client;
private ColyseusRoom<MatchRoomState> room;

async void ConnectToMatch()
{
    client = new ColyseusClient(serverUrl);

    var options = new Dictionary<string, object>
    {
        { "playerId", AuthManager.Instance.UserId },
        { "playerName", AuthManager.Instance.DisplayName },
        { "elo", PlayerProfile.Elo },
        { "deckId", DeckBuilder.Instance.ActiveDeckId }
    };

    try
    {
        room = await client.JoinOrCreate<MatchRoomState>("cricket_match", options);

        // Register message handlers
        room.OnMessage<TossScreen>("toss_screen", OnTossScreen);
        room.OnMessage<TossResult>("toss_result", OnTossResult);
        room.OnMessage<BallStart>("ball_start", OnBallStart);
        room.OnMessage<BallResult>("ball_result", OnBallResult);
        room.OnMessage<InningsStart>("innings_start", OnInningsStart);
        room.OnMessage<MatchEnd>("match_end", OnMatchEnd);

        // State change listener
        room.OnStateChange += OnStateChange;

        Debug.Log($"Connected to room: {room.Id}");
    }
    catch (Exception e)
    {
        Debug.LogError($"Failed to connect: {e.Message}");
    }
}

// Send heartbeat every 5 seconds
IEnumerator HeartbeatCoroutine()
{
    while (room != null && room.Connection.IsOpen)
    {
        room.Send("heartbeat");
        yield return new WaitForSeconds(5f);
    }
}
```

### Key Integration Points

| Unity System | Server Message | Direction |
|--------------|---------------|-----------|
| `SliderController` | `batsman_tap` (position) | Client → Server |
| `MatchController` | `ball_result` (outcome) | Server → Client |
| `DeckBuilder` | `deck_confirm` (cards) | Client → Server |
| `PowerSystem` | `power_activate` (powerId) | Client → Server |
| `ScoringEngine` | State sync (score/wickets) | Server → Client |

---

## Quick Reference: Deployment Checklist

1. Verify local build: `npm run build` succeeds
2. Test locally: `npm start` and run a match via Playground
3. Push to GitHub: `git push origin main`
4. Colyseus Cloud: Create app, link repo, set region to Mumbai
5. Deploy: Enable auto-deploy or trigger manually
6. Verify: `curl https://<your-url>/api/health`
7. Update Unity client: Change `serverUrl` to production URL
8. Monitor: Check logs and /monitor dashboard
