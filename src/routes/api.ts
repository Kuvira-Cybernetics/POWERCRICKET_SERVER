import type { Request, Response } from "express";

// ── In-Memory Data Store (replace with Firebase/Firestore in production) ──
const users: Map<string, any> = new Map();
const friendRequests: Map<string, any[]> = new Map();
const purchaseHistory: Map<string, any[]> = new Map();

// ── Seed Data ─────────────────────────────────────────────────────────────
const CARD_CATALOG = [
    { cardId: "bat_colour_code",    name: "Colour Code Master", role: "BattingStrategy", rarity: "Rare",      powerType: "ColourCode",     basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bat_prediction",     name: "Prediction Pro",     role: "BattingStrategy", rarity: "Epic",      powerType: "PredictionLine", basePower: 3, level: 1, coinCost: 1000, gemCost: 100 },
    { cardId: "bat_steady_hand",    name: "Steady Hand",        role: "BattingDefense",  rarity: "Common",    powerType: "SteadyHand",     basePower: 1, level: 1, coinCost: 200,  gemCost: 20  },
    { cardId: "bat_double_score",   name: "Double Score",       role: "BattingStrategy", rarity: "Legendary", powerType: "DoubleScore",    basePower: 4, level: 1, coinCost: 2000, gemCost: 200 },
    { cardId: "bat_shield_wicket",  name: "Shield Wicket",      role: "BattingDefense",  rarity: "Epic",      powerType: "ShieldWicket",   basePower: 3, level: 1, coinCost: 1000, gemCost: 100 },
    { cardId: "bat_time_freeze",    name: "Time Freeze",        role: "BattingDefense",  rarity: "Rare",      powerType: "TimeFreeze",     basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bat_extra_life",     name: "Extra Life",         role: "BattingDefense",  rarity: "Legendary", powerType: "ExtraLife",      basePower: 4, level: 1, coinCost: 2000, gemCost: 200 },
    { cardId: "bow_speed_boost",    name: "Speed Boost",        role: "BowlingFast",     rarity: "Rare",      powerType: "SpeedBoost",     basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bow_ghost_ball",     name: "Ghost Ball",         role: "BowlingSpin",     rarity: "Epic",      powerType: "GhostBall",      basePower: 3, level: 1, coinCost: 1000, gemCost: 100 },
    { cardId: "bow_pressure_aura",  name: "Pressure Aura",      role: "BowlingFast",     rarity: "Rare",      powerType: "PressureAura",   basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bat_classic_drive",  name: "Classic Drive",      role: "BattingStrategy", rarity: "Common",    powerType: "SteadyHand",     basePower: 1, level: 1, coinCost: 100,  gemCost: 10  },
    { cardId: "bat_wall_defense",   name: "Wall Defense",       role: "BattingDefense",  rarity: "Common",    powerType: "ShieldWicket",   basePower: 1, level: 1, coinCost: 100,  gemCost: 10  },
    { cardId: "bow_pace_attack",    name: "Pace Attack",        role: "BowlingFast",     rarity: "Common",    powerType: "SpeedBoost",     basePower: 1, level: 1, coinCost: 100,  gemCost: 10  },
    { cardId: "bow_spin_wizard",    name: "Spin Wizard",        role: "BowlingSpin",     rarity: "Common",    powerType: "GhostBall",      basePower: 1, level: 1, coinCost: 100,  gemCost: 10  },
    { cardId: "bow_yorker_king",    name: "Yorker King",        role: "BowlingFast",     rarity: "Rare",      powerType: "PressureAura",   basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bat_power_hitter",   name: "Power Hitter",       role: "BattingStrategy", rarity: "Rare",      powerType: "DoubleScore",    basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bow_mystery_spin",   name: "Mystery Spin",       role: "BowlingSpin",     rarity: "Epic",      powerType: "GhostBall",      basePower: 3, level: 1, coinCost: 1000, gemCost: 100 },
    { cardId: "bat_anchor",         name: "Anchor",             role: "BattingDefense",  rarity: "Rare",      powerType: "SteadyHand",     basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
    { cardId: "bow_bouncer_king",   name: "Bouncer King",       role: "BowlingFast",     rarity: "Epic",      powerType: "SpeedBoost",     basePower: 3, level: 1, coinCost: 1000, gemCost: 100 },
    { cardId: "bow_leg_break",      name: "Leg Break Artist",   role: "BowlingSpin",     rarity: "Rare",      powerType: "PressureAura",   basePower: 2, level: 1, coinCost: 500,  gemCost: 50  },
];

const STORE_ITEMS = [
    { itemId: "gem_small",   name: "Small Gem Pack",  type: "gems",   amount: 80,   priceINR: 79,   priceUSD: 0.99  },
    { itemId: "gem_medium",  name: "Medium Gem Pack", type: "gems",   amount: 400,  priceINR: 349,  priceUSD: 4.49  },
    { itemId: "gem_large",   name: "Large Gem Pack",  type: "gems",   amount: 900,  priceINR: 699,  priceUSD: 8.99  },
    { itemId: "gem_mega",    name: "Mega Gem Pack",   type: "gems",   amount: 2000, priceINR: 1299, priceUSD: 14.99 },
    { itemId: "coin_pack_1", name: "Coin Starter",    type: "coins",  amount: 1000, priceGems: 100 },
    { itemId: "coin_pack_2", name: "Coin Pro",        type: "coins",  amount: 5000, priceGems: 400 },
    { itemId: "card_pack_1", name: "Basic Card Pack", type: "cards",  cardCount: 3, priceCoins: 500  },
    { itemId: "card_pack_2", name: "Premium Card Pack", type: "cards", cardCount: 5, priceGems: 200  },
];

const DAILY_REWARDS = [
    { dayNumber: 1, rewardType: "coins", rewardAmount: 100,  bonusGems: 0  },
    { dayNumber: 2, rewardType: "coins", rewardAmount: 150,  bonusGems: 0  },
    { dayNumber: 3, rewardType: "coins", rewardAmount: 200,  bonusGems: 0  },
    { dayNumber: 4, rewardType: "coins", rewardAmount: 300,  bonusGems: 5  },
    { dayNumber: 5, rewardType: "coins", rewardAmount: 400,  bonusGems: 0  },
    { dayNumber: 6, rewardType: "coins", rewardAmount: 500,  bonusGems: 10 },
    { dayNumber: 7, rewardType: "coins", rewardAmount: 1000, bonusGems: 25 },
];

// Sample leaderboard
const leaderboard = [
    { rank: 1, playerId: "p001", playerName: "CricketKing",   elo: 1850, wins: 142 },
    { rank: 2, playerId: "p002", playerName: "PowerPlayer",   elo: 1780, wins: 128 },
    { rank: 3, playerId: "p003", playerName: "SixHitter",     elo: 1720, wins: 115 },
    { rank: 4, playerId: "p004", playerName: "SpinMaster",    elo: 1690, wins: 109 },
    { rank: 5, playerId: "p005", playerName: "FastBowler",    elo: 1650, wins: 101 },
];

// ── Helper: extract userId from Auth header (mock) ────────────────────────
function getUserId(req: Request): string {
    const auth = req.headers.authorization || "";
    // In production, decode JWT. For now, use a default user.
    return auth.replace("Bearer ", "") || "default_user";
}

function getOrCreateUser(userId: string) {
    if (!users.has(userId)) {
        users.set(userId, {
            playerId: userId,
            displayName: "Player",
            avatarId: "default",
            level: 1,
            xp: 0,
            elo: 1000,
            coins: 5000,
            gems: 100,
            wins: 0,
            losses: 0,
            matchesPlayed: 0,
            inventory: CARD_CATALOG.slice(0, 8).map(c => ({ ...c, instanceId: `${c.cardId}_${userId}` })),
            decks: [{ deckId: "deck_1", name: "Deck 1", cards: [] }],
            friends: [] as string[],
            dailyStreak: 0,
            lastDailyReward: "",
        });
    }
    return users.get(userId);
}

// ── Register Express Routes ───────────────────────────────────────────────
export function registerApiRoutes(app: any) {

    // ── Auth ──────────────────────────────────────────────────────────────
    app.post("/auth/register", (req: Request, res: Response) => {
        const { email, password, username } = req.body || {};
        const userId = `user_${Date.now()}`;
        const user = getOrCreateUser(userId);
        user.displayName = username || "Player";
        const token = userId; // Mock token = userId
        res.json({ token, refreshToken: `refresh_${userId}`, playerId: userId, displayName: user.displayName });
    });

    app.post("/auth/login", (req: Request, res: Response) => {
        const userId = req.body?.email || "default_user";
        const user = getOrCreateUser(userId);
        res.json({ token: userId, refreshToken: `refresh_${userId}`, playerId: userId, displayName: user.displayName });
    });

    app.post("/auth/refresh", (req: Request, res: Response) => {
        const userId = (req.body?.refreshToken || "").replace("refresh_", "") || "default_user";
        res.json({ token: userId, refreshToken: `refresh_${userId}`, playerId: userId });
    });

    app.post("/auth/logout", (_req: Request, res: Response) => {
        res.json({});
    });

    // ── Profile ───────────────────────────────────────────────────────────
    app.get("/profile/me", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        res.json({ playerId: user.playerId, displayName: user.displayName, avatarId: user.avatarId,
            level: user.level, xp: user.xp, elo: user.elo, coins: user.coins, gems: user.gems });
    });

    app.put("/profile/me", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        if (req.body?.displayName) user.displayName = req.body.displayName;
        if (req.body?.avatarId) user.avatarId = req.body.avatarId;
        res.json({ playerId: user.playerId, displayName: user.displayName, avatarId: user.avatarId,
            level: user.level, xp: user.xp, elo: user.elo, coins: user.coins, gems: user.gems });
    });

    app.get("/profile/:id/stats", (req: Request, res: Response) => {
        const user = getOrCreateUser(req.params.id);
        res.json({ playerId: user.playerId, wins: user.wins, losses: user.losses,
            matchesPlayed: user.matchesPlayed, elo: user.elo, level: user.level });
    });

    // ── Cards ─────────────────────────────────────────────────────────────
    app.get("/cards/catalog", (_req: Request, res: Response) => {
        res.json({ cards: CARD_CATALOG });
    });

    app.get("/cards/inventory", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        res.json({ cards: user.inventory });
    });

    app.post("/cards/upgrade", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        const card = user.inventory.find((c: any) => c.cardId === req.body?.cardId);
        if (!card) { res.status(404).json({ error: "Card not found" }); return; }
        const cost = card.coinCost * Math.pow(2, card.level - 1);
        if (user.coins < cost) { res.status(400).json({ error: "Insufficient coins" }); return; }
        user.coins -= cost;
        card.level++;
        card.basePower = Math.min(card.basePower + 1, 10);
        res.json({ cardId: card.cardId, newLevel: card.level, newBasePower: card.basePower, coinsRemaining: user.coins });
    });

    app.post("/cards/fuse", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        const { cardId1, cardId2 } = req.body || {};
        const idx1 = user.inventory.findIndex((c: any) => c.instanceId === cardId1);
        const idx2 = user.inventory.findIndex((c: any) => c.instanceId === cardId2);
        if (idx1 < 0 || idx2 < 0) { res.status(404).json({ error: "Card(s) not found" }); return; }
        const c1 = user.inventory[idx1];
        const c2 = user.inventory[idx2];
        if (c1.cardId !== c2.cardId) { res.status(400).json({ error: "Cards must be same type" }); return; }
        c1.level++;
        c1.basePower = Math.min(c1.basePower + 1, 10);
        user.inventory.splice(idx2, 1);
        res.json({ resultCard: c1, inventoryCount: user.inventory.length });
    });

    // ── Store ─────────────────────────────────────────────────────────────
    app.get("/store/items", (_req: Request, res: Response) => {
        res.json({ items: STORE_ITEMS, dailyDeals: STORE_ITEMS.slice(0, 2) });
    });

    app.post("/store/purchase", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        const item = STORE_ITEMS.find(i => i.itemId === req.body?.itemId);
        if (!item) { res.status(404).json({ error: "Item not found" }); return; }

        // Process purchase based on currency
        if (item.type === "gems") {
            user.gems += item.amount;
        } else if (item.type === "coins") {
            const cost = (item as any).priceGems || 0;
            if (user.gems < cost) { res.status(400).json({ error: "Insufficient gems" }); return; }
            user.gems -= cost;
            user.coins += item.amount;
        }

        const record = { transactionId: `tx_${Date.now()}`, itemId: item.itemId, itemName: item.name, timestamp: Date.now() };
        if (!purchaseHistory.has(user.playerId)) purchaseHistory.set(user.playerId, []);
        purchaseHistory.get(user.playerId)!.push(record);

        res.json({ success: true, ...record, coinsBalance: user.coins, gemsBalance: user.gems });
    });

    app.get("/store/history", (req: Request, res: Response) => {
        const userId = getUserId(req);
        res.json({ purchases: purchaseHistory.get(userId) || [] });
    });

    // ── Matchmaking (REST fallback — primary is WebSocket) ────────────────
    app.post("/matchmaking/find", (req: Request, res: Response) => {
        res.json({ status: "queued", message: "Use WebSocket lobby for real-time matchmaking" });
    });

    app.post("/matchmaking/cancel", (_req: Request, res: Response) => {
        res.json({ status: "cancelled" });
    });

    // ── Social / Friends ──────────────────────────────────────────────────
    app.get("/social/friends", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        const friends = user.friends.map((fid: string) => {
            const f = getOrCreateUser(fid);
            return { playerId: f.playerId, displayName: f.displayName, elo: f.elo, online: false };
        });
        res.json({ friends });
    });

    app.post("/social/friend-request", (req: Request, res: Response) => {
        const userId = getUserId(req);
        const targetId = req.body?.targetPlayerId;
        if (!targetId) { res.status(400).json({ error: "targetPlayerId required" }); return; }
        if (!friendRequests.has(targetId)) friendRequests.set(targetId, []);
        friendRequests.get(targetId)!.push({ from: userId, timestamp: Date.now() });
        res.json({ status: "sent", targetPlayerId: targetId });
    });

    app.post("/social/friend-accept", (req: Request, res: Response) => {
        const userId = getUserId(req);
        const fromId = req.body?.playerId;
        const user = getOrCreateUser(userId);
        const from = getOrCreateUser(fromId);
        if (!user.friends.includes(fromId)) user.friends.push(fromId);
        if (!from.friends.includes(userId)) from.friends.push(userId);
        // Remove request
        const reqs = friendRequests.get(userId) || [];
        friendRequests.set(userId, reqs.filter((r: any) => r.from !== fromId));
        res.json({});
    });

    app.post("/social/friend-remove", (req: Request, res: Response) => {
        const userId = getUserId(req);
        const targetId = req.body?.playerId;
        const user = getOrCreateUser(userId);
        user.friends = user.friends.filter((f: string) => f !== targetId);
        const target = getOrCreateUser(targetId);
        target.friends = target.friends.filter((f: string) => f !== userId);
        res.json({});
    });

    // ── Leaderboard ───────────────────────────────────────────────────────
    app.get("/leaderboard/global", (req: Request, res: Response) => {
        const limit = parseInt(req.query.limit as string) || 100;
        res.json({ entries: leaderboard.slice(0, limit), updatedAt: Date.now() });
    });

    app.get("/leaderboard/friends", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        const entries = user.friends.map((fid: string, i: number) => {
            const f = getOrCreateUser(fid);
            return { rank: i + 1, playerId: f.playerId, playerName: f.displayName, elo: f.elo, wins: f.wins };
        });
        // Add self
        entries.push({ rank: entries.length + 1, playerId: user.playerId, playerName: user.displayName, elo: user.elo, wins: user.wins });
        entries.sort((a: any, b: any) => b.elo - a.elo);
        entries.forEach((e: any, i: number) => e.rank = i + 1);
        res.json({ entries, updatedAt: Date.now() });
    });

    app.get("/leaderboard/weekly", (req: Request, res: Response) => {
        const limit = parseInt(req.query.limit as string) || 100;
        res.json({ entries: leaderboard.slice(0, limit), updatedAt: Date.now(), season: "Week 12" });
    });

    // ── Rewards ───────────────────────────────────────────────────────────
    app.post("/rewards/claim-daily", (req: Request, res: Response) => {
        const user = getOrCreateUser(getUserId(req));
        const today = new Date().toISOString().split("T")[0];
        if (user.lastDailyReward === today) {
            res.status(400).json({ error: "Already claimed today" });
            return;
        }
        // Reset streak if missed a day
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
        if (user.lastDailyReward !== yesterday) user.dailyStreak = 0;

        user.dailyStreak = (user.dailyStreak % 7) + 1;
        user.lastDailyReward = today;

        const reward = DAILY_REWARDS[user.dailyStreak - 1];
        if (reward.rewardType === "coins") user.coins += reward.rewardAmount;
        else if (reward.rewardType === "gems") user.gems += reward.rewardAmount;
        if (reward.bonusGems > 0) user.gems += reward.bonusGems;

        res.json({
            coinsGranted: reward.rewardType === "coins" ? reward.rewardAmount : 0,
            gemsGranted: (reward.rewardType === "gems" ? reward.rewardAmount : 0) + (reward.bonusGems || 0),
            streakDay: user.dailyStreak,
        });
    });

    // ── Match History ─────────────────────────────────────────────────────
    app.get("/match/history", (req: Request, res: Response) => {
        // In production, fetch from Firestore
        res.json({ matches: [] });
    });

    // ── Tournaments ───────────────────────────────────────────────────────
    app.get("/tournaments", (_req: Request, res: Response) => {
        res.json({ tournaments: [
            { id: "t1", name: "Weekend Blitz", status: "active", entryFee: 100, prizePool: 5000, participants: 64, maxParticipants: 128 },
            { id: "t2", name: "Monthly Championship", status: "upcoming", entryFee: 500, prizePool: 25000, participants: 0, maxParticipants: 256 },
        ]});
    });

    app.post("/tournaments/:id/register", (req: Request, res: Response) => {
        res.json({ status: "registered", tournamentId: req.params.id });
    });

    // ── Notifications ─────────────────────────────────────────────────────
    app.get("/notifications", (_req: Request, res: Response) => {
        res.json({ notifications: [
            { id: "n1", type: "system", title: "Welcome!", message: "Welcome to Power Cricket!", read: false, timestamp: Date.now() - 3600000 },
            { id: "n2", type: "reward", title: "Daily Reward", message: "Don't forget to claim your daily reward!", read: false, timestamp: Date.now() },
        ]});
    });

    app.post("/notifications/read-all", (_req: Request, res: Response) => {
        res.json({ markedRead: 2 });
    });

    // ── Game Config ────────────────────────────────────────────────────────
    app.get("/config/game", (_req: Request, res: Response) => {
        res.json({
            match_overs: 3,
            match_balls_per_over: 6,
            arrow_speed_multiplier: 1.0,
            super_over_enabled: true,
            max_powers_per_card: 3,
            bot_injection_rate: 0.3,
            disabled_card_ids: "",
            matchmaking_timeout: 30,
            coin_reward_win: 50,
            coin_reward_loss: 15,
            xp_reward_win: 30,
            xp_reward_loss: 10,
            trophy_reward_win: 30,
            trophy_reward_loss: -20,
            daily_deal_rotation: "card_pack_1,card_pack_2",
            deck_max_spin_bowlers: 2,
            deck_min_fast_bowlers: 1,
            disconnect_grace_period: 30,
            match_timer_per_ball: 30,
        });
    });

    console.log("[API] Registered 25+ REST endpoints");
}
