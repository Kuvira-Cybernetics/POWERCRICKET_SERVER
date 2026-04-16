# Game Config Setup

Server now reads live game config from Firestore document `gameConfig/match`. Admin site writes → server reads on startup + refreshes every 5 min.

## 1. Firestore document schema

**Project:** `powercricket-c5578` (override with `FIREBASE_PROJECT_ID` env var)

**Collection / Doc:** `gameConfig/match`

```json
{
  "oversPerMatch":          3,
  "ballsPerOver":           6,
  "superOverEnabled":       true,
  "matchmakingTimeout":     30,
  "botInjectionRate":       0.3,

  "botCatchRate":           0.1,
  "botWicketZoneFactor":    0.1,

  "coinRewardWin":          50,
  "coinRewardLoss":         15,
  "xpRewardWin":            30,
  "xpRewardLoss":           10,
  "trophyRewardWin":        30,
  "trophyRewardLoss":       -20,

  "teamMaxSpinBowlers":     2,
  "teamMinFastBowlers":     1,
  "maxPowersPerPlayer":     3,

  "disconnectGracePeriod":  30,
  "matchTimerPerBall":      30,
  "arrowSpeedMultiplier":   1.0
}
```

### Field ranges (server clamps out-of-range values)

| Field | Range |
|---|---|
| `oversPerMatch` | 1 – 20 |
| `ballsPerOver` | 1 – 12 |
| `botCatchRate` | 0.0 – 1.0 |
| `botWicketZoneFactor` | 0.0 – 1.0 |
| `superOverEnabled` | `true` / `false` |
| `matchmakingTimeout` | 5 – 300 sec |
| `botInjectionRate` | 0.0 – 1.0 |
| `maxPowersPerPlayer` | 0 – 10 |
| `teamMaxSpinBowlers` | 0 – 11 |
| `teamMinFastBowlers` | 0 – 11 |
| `disconnectGracePeriod` | 0 – 600 sec |
| `matchTimerPerBall` | 1 – 300 sec |
| `arrowSpeedMultiplier` | 0.1 – 10 |
| reward fields | sensible ranges, see `src/config/gameConfig.ts` |

### Bot difficulty meaning

- **`botCatchRate`** — when bot is fielding a 4/6 boundary, probability it takes the catch. `0.1` = 10% (rare wickets). `0.0` = never catches. `1.0` = always catches.
- **`botWicketZoneFactor`** — multiplier applied to the bowling pattern's wicket zone weight when bot is bowling. `0.1` = 10× smaller wicket zone (human batsman rarely taps into wicket). `1.0` = no shrink.

Neither field is exposed to clients — both are enforced server-side only.

## 2. Service account key

Server needs Firebase Admin credentials. Get them from:

Firebase Console → Project Settings → Service Accounts → **Generate new private key** → downloads a JSON file.

### Local dev (Windows)

```powershell
# Save the JSON somewhere outside the repo (do NOT commit)
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Users\ABDON\secrets\powercricket-admin.json"
cd PowerCricketServer
npm install       # first time only (installs firebase-admin)
npm start
```

### Colyseus Cloud (recommended)

Upload the JSON as a single-line env var so no file needs mounting:

1. Open the JSON, copy its full contents.
2. Colyseus Cloud → your app → **Environment Variables** → add:
   - `FIREBASE_SERVICE_ACCOUNT` = `{"type":"service_account","project_id":"powercricket-c5578",...}` (paste full JSON on one line)
   - `FIREBASE_PROJECT_ID` = `powercricket-c5578` (optional — defaults to this)
3. Redeploy.

### No credentials? Server still runs.

If neither env var is set, server logs a warning and uses defaults (see `DEFAULTS` in `src/config/gameConfig.ts`). Useful for local testing without touching Firestore.

## 2.5. Seed the Firestore doc (one-time)

Instead of creating the doc by hand in the Firebase console, run:

```bash
# PowerShell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\key.json"
npm run seed:config

# bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npm run seed:config
```

Behavior:
- If the doc doesn't exist → creates it with defaults.
- If it already exists → **merges only missing fields** (safe re-run).
- Pass `--overwrite` to replace the doc entirely:
  ```
  npx tsx scripts/seed-game-config.ts --overwrite
  ```

## 3. Verify it's working

After server start, you should see:

```
[FirebaseAdmin] Initialized (project=powercricket-c5578)
[GameConfig] Loaded from Firestore (overs=3, balls=6, botCatch=0.1, botWicketFactor=0.1)
[PowerLoader] Loaded N power definitions from Firestore.
```

If the doc is missing, server logs:
```
[GameConfig] gameConfig/match not found — keeping defaults.
```
→ Create the doc in Firestore with the schema above.

## 4. Config refresh

- Server fetches once at startup.
- Re-fetches every **5 minutes**.
- Changes in the Firestore doc propagate to new matches (existing matches keep their snapshot).
- No server restart needed.

## 5. Security

- **Client never sees bot difficulty.** `botCatchRate` + `botWicketZoneFactor` are read by `LobbyRoom` (server-side) and passed into `MatchRoom` options. Client cannot override.
- **Firestore rules:** admin-only writes to `gameConfig/match`. Allow server (service account) full access via Admin SDK — Admin SDK bypasses rules. Lock down client reads/writes:

  ```
  match /gameConfig/{doc} {
    allow read, write: if false;   // server-only via Admin SDK
  }
  ```

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No credentials configured — Firestore disabled` | Env vars missing | Set `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_SERVICE_ACCOUNT` |
| `Initialization failed` | Bad JSON key / wrong project | Regenerate key; check `FIREBASE_PROJECT_ID` |
| Config changes not appearing | 5-min refresh window | Wait or restart server |
| Wicket zone still frequent for bot | Cached config still shows old value | Check server log for last `[GameConfig] Loaded…` line |
