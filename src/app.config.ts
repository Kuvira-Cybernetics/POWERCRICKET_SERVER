import {
    defineServer,
    defineRoom,
    monitor,
    playground,
    createRouter,
    createEndpoint,
} from "colyseus";
import express from "express";

/**
 * Import your Room files
 */
import { MyRoom } from "./rooms/MyRoom.js";

// ============================================================================
// MOCK DATA STORES (In-Memory)
// ============================================================================

interface User {
    userId: string;
    email: string;
    username: string;
    passwordHash: string;
    avatar: string;
    level: number;
    xp: number;
    elo: number;
    tier: string;
    trophies: number;
    coins: number;
    gems: number;
    createdAt: number;
}

interface Card {
    cardId: string;
    name: string;
    role: string; // BattingStrategy, BattingDefense, BowlingFast, BowlingSpin
    rarity: string; // Common, Rare, Epic, Legendary
    powerType: string;
    basePower: number;
    description: string;
}

interface InventoryCard {
    cardId: string;
    level: number;
    copies: number;
}

interface StorePurchase {
    id: string;
    userId: string;
    itemId: string;
    amount: number;
    currency: string;
    timestamp: number;
}

interface MatchSession {
    matchId: string;
    userId: string;
    elo: number;
    deckId: string;
    status: string; // "waiting", "matched", "playing", "completed"
    opponentId?: string;
    createdAt: number;
}

interface Friend {
    userId: string;
    friendId: string;
    status: string; // "pending", "accepted", "blocked"
    createdAt: number;
}

// Mock data storage
const users = new Map<string, User>();
const userInventories = new Map<string, InventoryCard[]>();
const cardCatalog: Card[] = [
    // Batting cards
    { cardId: "bat_001", name: "Colour Code", role: "BattingStrategy", rarity: "Common", powerType: "Colour Code", basePower: 1.1, description: "Gains 10% power if previous ball was dot" },
    { cardId: "bat_002", name: "Prediction Line", role: "BattingStrategy", rarity: "Rare", powerType: "Prediction Line", basePower: 1.2, description: "See next 2 deliveries in advance" },
    { cardId: "bat_003", name: "Speed Boost", role: "BattingDefense", rarity: "Rare", powerType: "Speed Boost", basePower: 1.15, description: "Increase slider speed by 20%" },
    { cardId: "bat_004", name: "Time Freeze", role: "BattingDefense", rarity: "Epic", powerType: "Time Freeze", basePower: 1.3, description: "Freeze time for 0.5 seconds" },
    { cardId: "bat_005", name: "Double Score", role: "BattingStrategy", rarity: "Epic", powerType: "Double Score", basePower: 1.4, description: "Double runs for next 2 balls" },
    { cardId: "bat_006", name: "Shield Wicket", role: "BattingDefense", rarity: "Legendary", powerType: "Shield Wicket", basePower: 1.5, description: "Survive 1 wicket, restore on next over" },
    { cardId: "bat_007", name: "Ghost Ball", role: "BattingStrategy", rarity: "Epic", powerType: "Ghost Ball", basePower: 1.35, description: "Confuse bowler, reduce accuracy by 30%" },
    { cardId: "bat_008", name: "Extra Life", role: "BattingDefense", rarity: "Legendary", powerType: "Extra Life", basePower: 1.5, description: "Gain 1 extra wicket" },
    { cardId: "bat_009", name: "Pressure Aura", role: "BattingStrategy", rarity: "Rare", powerType: "Pressure Aura", basePower: 1.2, description: "Increase score by 20% every 3rd ball" },
    { cardId: "bat_010", name: "Steady Hand", role: "BattingDefense", rarity: "Common", powerType: "Steady Hand", basePower: 1.05, description: "Reduce dot ball probability by 10%" },
    // Bowling cards
    { cardId: "bowl_001", name: "Colour Code", role: "BowlingFast", rarity: "Common", powerType: "Colour Code", basePower: 1.1, description: "Gains 10% accuracy if previous ball was dot" },
    { cardId: "bowl_002", name: "Prediction Line", role: "BowlingSpin", rarity: "Rare", powerType: "Prediction Line", basePower: 1.2, description: "Read batsman's weakness" },
    { cardId: "bowl_003", name: "Speed Boost", role: "BowlingFast", rarity: "Rare", powerType: "Speed Boost", basePower: 1.15, description: "Increase delivery speed by 25%" },
    { cardId: "bowl_004", name: "Time Freeze", role: "BowlingSpin", rarity: "Epic", powerType: "Time Freeze", basePower: 1.3, description: "Slow down batsman reaction" },
    { cardId: "bowl_005", name: "Double Score", role: "BowlingFast", rarity: "Epic", powerType: "Double Score", basePower: 1.4, description: "Double wicket value for next over" },
    { cardId: "bowl_006", name: "Shield Wicket", role: "BowlingSpin", rarity: "Legendary", powerType: "Shield Wicket", basePower: 1.5, description: "Guaranteed wicket on perfect line" },
    { cardId: "bowl_007", name: "Ghost Ball", role: "BowlingFast", rarity: "Epic", powerType: "Ghost Ball", basePower: 1.35, description: "Ball swerves unpredictably" },
    { cardId: "bowl_008", name: "Extra Life", role: "BowlingSpin", rarity: "Legendary", powerType: "Extra Life", basePower: 1.5, description: "Survive 1 boundary without penalty" },
    { cardId: "bowl_009", name: "Pressure Aura", role: "BowlingFast", rarity: "Rare", powerType: "Pressure Aura", basePower: 1.2, description: "Increase dot ball rate by 25%" },
    { cardId: "bowl_010", name: "Steady Hand", role: "BowlingSpin", rarity: "Common", powerType: "Steady Hand", basePower: 1.05, description: "Consistent line and length" },
];

const storePurchases = new Map<string, StorePurchase[]>();
const matchmakingQueue = new Map<string, MatchSession>();
const friendships = new Map<string, Friend[]>();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getUser(userId: string): User | null {
    return users.get(userId) || null;
}

function createUser(email: string, username: string, passwordHash: string): User {
    const userId = generateId();
    const user: User = {
        userId,
        email,
        username,
        passwordHash,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        level: 1,
        xp: 0,
        elo: 1000,
        tier: "Bronze",
        trophies: 0,
        coins: 100,
        gems: 0,
        createdAt: Date.now(),
    };
    users.set(userId, user);
    userInventories.set(userId, initializeInventory());
    return user;
}

function initializeInventory(): InventoryCard[] {
    // Give player first 5 cards (mixed batting/bowling)
    return [
        { cardId: "bat_001", level: 1, copies: 1 },
        { cardId: "bat_002", level: 1, copies: 1 },
        { cardId: "bowl_001", level: 1, copies: 1 },
        { cardId: "bowl_002", level: 1, copies: 1 },
        { cardId: "bat_010", level: 1, copies: 1 },
    ];
}

function getCardFromCatalog(cardId: string): Card | null {
    return cardCatalog.find(c => c.cardId === cardId) || null;
}

// ============================================================================
// SERVER DEFINITION
// ============================================================================

const server = defineServer({
    /**
     * Define your room handlers
     */
    rooms: {
        // Standard public match room
        cricket_match: defineRoom(MyRoom),
        // Private match room (with room code)
        private_match: defineRoom(MyRoom),
        // Legacy alias
        my_room: defineRoom(MyRoom),
    },

    /**
     * Define API routes (Colyseus createRouter)
     */
    routes: createRouter({
        api_hello: createEndpoint("/api/hello", { method: "GET" }, async (ctx) => {
            return { message: "Power Cricket Server Running" };
        }),
        api_health: createEndpoint("/api/health", { method: "GET" }, async (ctx) => {
            return {
                status: "ok",
                uptime: process.uptime(),
                timestamp: Date.now(),
                version: "1.0.0",
            };
        }),
    }),

    /**
     * Express routes for REST API endpoints
     */
    express: (app) => {
        // Middleware
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        // CORS headers
        app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
            res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
            if (req.method === "OPTIONS") {
                return res.sendStatus(200);
            }
            next();
        });

        // ====================================================================
        // AUTH ROUTES
        // ====================================================================

        app.post("/api/auth/register", (req, res) => {
            const { email, password, username } = req.body;

            if (!email || !password || !username) {
                return res.status(400).json({ error: "Missing required fields" });
            }

            // Check if user exists
            for (const user of users.values()) {
                if (user.email === email) {
                    return res.status(409).json({ error: "Email already registered" });
                }
            }

            const passwordHash = Buffer.from(password).toString("base64"); // Mock hash
            const user = createUser(email, username, passwordHash);

            const token = generateId();
            const refreshToken = generateId();

            return res.status(201).json({
                userId: user.userId,
                token,
                refreshToken,
            });
        });

        app.post("/api/auth/login", (req, res) => {
            const { email, password } = req.body;

            if (!email || !password) {
                return res.status(400).json({ error: "Missing email or password" });
            }

            let foundUser: User | null = null;
            for (const user of users.values()) {
                if (user.email === email) {
                    foundUser = user;
                    break;
                }
            }

            if (!foundUser) {
                return res.status(401).json({ error: "Invalid credentials" });
            }

            const passwordHash = Buffer.from(password).toString("base64");
            if (foundUser.passwordHash !== passwordHash) {
                return res.status(401).json({ error: "Invalid credentials" });
            }

            const token = generateId();
            const refreshToken = generateId();

            return res.json({
                userId: foundUser.userId,
                token,
                refreshToken,
                profile: {
                    username: foundUser.username,
                    avatar: foundUser.avatar,
                    level: foundUser.level,
                    elo: foundUser.elo,
                    tier: foundUser.tier,
                },
            });
        });

        app.post("/api/auth/refresh", (req, res) => {
            const { refreshToken } = req.body;

            if (!refreshToken) {
                return res.status(400).json({ error: "Missing refreshToken" });
            }

            // Mock validation
            const newToken = generateId();
            const newRefreshToken = generateId();

            return res.json({
                token: newToken,
                refreshToken: newRefreshToken,
            });
        });

        app.post("/api/auth/logout", (req, res) => {
            const { token } = req.body;

            if (!token) {
                return res.status(400).json({ error: "Missing token" });
            }

            return res.json({ success: true });
        });

        // ====================================================================
        // PROFILE ROUTES
        // ====================================================================

        app.get("/api/profile/:userId", (req, res) => {
            const { userId } = req.params;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            return res.json({
                userId: user.userId,
                username: user.username,
                avatar: user.avatar,
                level: user.level,
                xp: user.xp,
                elo: user.elo,
                tier: user.tier,
                trophies: user.trophies,
            });
        });

        app.put("/api/profile/:userId", (req, res) => {
            const { userId } = req.params;
            const { username, avatar } = req.body;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            if (username) user.username = username;
            if (avatar) user.avatar = avatar;

            return res.json({
                userId: user.userId,
                username: user.username,
                avatar: user.avatar,
                level: user.level,
                xp: user.xp,
                elo: user.elo,
                tier: user.tier,
                trophies: user.trophies,
            });
        });

        app.get("/api/profile/:userId/stats", (req, res) => {
            const { userId } = req.params;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            return res.json({
                userId: user.userId,
                matchesPlayed: 42,
                wins: 28,
                losses: 14,
                winRate: 0.667,
                highScore: 156,
                currentStreak: 5,
            });
        });

        // ====================================================================
        // CARD ROUTES
        // ====================================================================

        app.get("/api/cards/catalog", (req, res) => {
            return res.json({
                cards: cardCatalog.map(card => ({
                    cardId: card.cardId,
                    name: card.name,
                    role: card.role,
                    rarity: card.rarity,
                    powerType: card.powerType,
                    basePower: card.basePower,
                    description: card.description,
                })),
            });
        });

        app.get("/api/cards/inventory/:userId", (req, res) => {
            const { userId } = req.params;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const inventory = userInventories.get(userId) || [];
            const enriched = inventory.map(inv => {
                const card = getCardFromCatalog(inv.cardId);
                return {
                    cardId: inv.cardId,
                    name: card?.name || "Unknown",
                    level: inv.level,
                    copies: inv.copies,
                    rarity: card?.rarity || "Common",
                };
            });

            return res.json({ cards: enriched });
        });

        app.post("/api/cards/upgrade", (req, res) => {
            const { userId, cardId } = req.body;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const inventory = userInventories.get(userId) || [];
            const inventoryCard = inventory.find(c => c.cardId === cardId);

            if (!inventoryCard) {
                return res.status(404).json({ error: "Card not found in inventory" });
            }

            const upgradeCosts = [1, 2, 4, 8, 16];
            const currentLevel = Math.min(inventoryCard.level - 1, 4);
            const cost = upgradeCosts[currentLevel] || 16;

            if (user.coins < cost) {
                return res.status(400).json({ error: "Insufficient coins" });
            }

            user.coins -= cost;
            inventoryCard.level += 1;
            const card = getCardFromCatalog(cardId);

            return res.json({
                card: {
                    cardId: card?.cardId,
                    name: card?.name,
                    newLevel: inventoryCard.level,
                },
                cost,
                balance: user.coins,
            });
        });

        app.post("/api/cards/fuse", (req, res) => {
            const { userId, cardId1, cardId2 } = req.body;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const inventory = userInventories.get(userId) || [];
            const card1 = inventory.find(c => c.cardId === cardId1);
            const card2 = inventory.find(c => c.cardId === cardId2);

            if (!card1 || !card2 || card1.copies < 1 || card2.copies < 1) {
                return res.status(400).json({ error: "Insufficient cards for fusion" });
            }

            card1.copies -= 1;
            card2.copies -= 1;
            card1.level += 1; // Mock: upgrade first card

            return res.status(201).json({
                newCard: {
                    cardId: cardId1,
                    name: getCardFromCatalog(cardId1)?.name,
                    level: card1.level,
                },
            });
        });

        // ====================================================================
        // STORE ROUTES
        // ====================================================================

        app.get("/api/store/items", (req, res) => {
            return res.json({
                items: [
                    { itemId: "gems_small", name: "Small Gem Pack", amount: 50, price: 79, currency: "INR" },
                    { itemId: "gems_medium", name: "Medium Gem Pack", amount: 250, price: 349, currency: "INR" },
                    { itemId: "gems_large", name: "Large Gem Pack", amount: 500, price: 699, currency: "INR" },
                    { itemId: "gems_mega", name: "Mega Gem Pack", amount: 1000, price: 1299, currency: "INR" },
                    { itemId: "coins_boost", name: "Coin Booster (24h)", amount: 500, price: 50, currency: "gems" },
                    { itemId: "xp_boost", name: "XP Booster (24h)", amount: 1000, price: 75, currency: "gems" },
                ],
            });
        });

        app.post("/api/store/purchase", (req, res) => {
            const { userId, itemId, currency } = req.body;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const priceMap: { [key: string]: number } = {
                gems_small: 79,
                gems_medium: 349,
                gems_large: 699,
                gems_mega: 1299,
                coins_boost: 50,
                xp_boost: 75,
            };

            const price = priceMap[itemId];
            if (price === undefined) {
                return res.status(404).json({ error: "Item not found" });
            }

            if (currency === "gems" && user.gems < price) {
                return res.status(400).json({ error: "Insufficient gems" });
            }

            if (currency === "coins" && user.coins < price) {
                return res.status(400).json({ error: "Insufficient coins" });
            }

            if (currency === "gems") user.gems -= price;
            if (currency === "coins") user.coins -= price;

            const purchase: StorePurchase = {
                id: generateId(),
                userId,
                itemId,
                amount: price,
                currency,
                timestamp: Date.now(),
            };

            if (!storePurchases.has(userId)) {
                storePurchases.set(userId, []);
            }
            storePurchases.get(userId)!.push(purchase);

            return res.status(201).json({
                success: true,
                item: { itemId },
                balance: currency === "gems" ? user.gems : user.coins,
            });
        });

        app.get("/api/store/history/:userId", (req, res) => {
            const { userId } = req.params;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const purchases = storePurchases.get(userId) || [];
            return res.json({
                purchases: purchases.map(p => ({
                    id: p.id,
                    itemId: p.itemId,
                    amount: p.amount,
                    currency: p.currency,
                    timestamp: p.timestamp,
                })),
            });
        });

        // ====================================================================
        // DECK VALIDATION ROUTE
        // ====================================================================

        app.post("/api/deck/validate", (req, res) => {
            const { battingCards, bowlingCards } = req.body;

            if (!Array.isArray(battingCards) || !Array.isArray(bowlingCards)) {
                return res.status(400).json({ error: "battingCards and bowlingCards must be arrays" });
            }

            // Must have exactly 2 batting cards
            if (battingCards.length !== 2) {
                return res.status(200).json({ valid: false, error: "Deck must contain exactly 2 batting cards" });
            }

            // Must have 2-3 bowling cards
            if (bowlingCards.length < 2 || bowlingCards.length > 3) {
                return res.status(200).json({ valid: false, error: "Deck must contain 2-3 bowling cards" });
            }

            // Validate batting card roles
            for (const card of battingCards) {
                if (!["BattingStrategy", "BattingDefense"].includes(card.role)) {
                    return res.status(200).json({ valid: false, error: `Invalid batting card role: ${card.role}` });
                }
            }

            // Validate bowling card composition
            let fastCount = 0;
            let spinCount = 0;
            for (const card of bowlingCards) {
                if (card.role === "BowlingFast") fastCount++;
                else if (card.role === "BowlingSpin") spinCount++;
                else return res.status(200).json({ valid: false, error: `Invalid bowling card role: ${card.role}` });
            }

            if (fastCount < 1) {
                return res.status(200).json({ valid: false, error: "Deck must contain at least 1 Fast bowler" });
            }
            if (spinCount > 2) {
                return res.status(200).json({ valid: false, error: "Deck cannot contain more than 2 Spin bowlers" });
            }

            return res.json({ valid: true });
        });

        // ====================================================================
        // MATCHMAKING ROUTES
        // ====================================================================

        app.post("/api/matchmaking/find", (req, res) => {
            const { userId, elo, deckId } = req.body;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const matchId = generateId();
            const match: MatchSession = {
                matchId,
                userId,
                elo,
                deckId,
                status: "waiting",
                createdAt: Date.now(),
            };

            matchmakingQueue.set(matchId, match);

            // Mock: 50% chance to find opponent immediately
            if (Math.random() > 0.5) {
                match.status = "matched";
                match.opponentId = generateId();
            }

            return res.status(201).json({
                matchId,
                status: match.status,
            });
        });

        app.delete("/api/matchmaking/cancel", (req, res) => {
            const { userId } = req.body;

            let cancelled = false;
            for (const [key, match] of matchmakingQueue.entries()) {
                if (match.userId === userId) {
                    matchmakingQueue.delete(key);
                    cancelled = true;
                    break;
                }
            }

            return res.json({ cancelled });
        });

        // ====================================================================
        // SOCIAL ROUTES
        // ====================================================================

        app.get("/api/friends/:userId", (req, res) => {
            const { userId } = req.params;
            const user = getUser(userId);

            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            const userFriends = friendships.get(userId) || [];
            const accepted = userFriends
                .filter(f => f.status === "accepted")
                .map(f => ({
                    friendId: f.friendId,
                    username: getUser(f.friendId)?.username || "Unknown",
                    elo: getUser(f.friendId)?.elo || 0,
                }));

            return res.json({ friends: accepted });
        });

        app.post("/api/friends/request", (req, res) => {
            const { userId, targetId } = req.body;
            const user = getUser(userId);
            const target = getUser(targetId);

            if (!user || !target) {
                return res.status(404).json({ error: "User not found" });
            }

            const requestId = generateId();
            const friendship: Friend = {
                userId,
                friendId: targetId,
                status: "pending",
                createdAt: Date.now(),
            };

            if (!friendships.has(userId)) {
                friendships.set(userId, []);
            }
            friendships.get(userId)!.push(friendship);

            return res.status(201).json({ requestId });
        });

        app.delete("/api/friends/:userId/:friendId", (req, res) => {
            const { userId, friendId } = req.params;

            const userFriends = friendships.get(userId) || [];
            const index = userFriends.findIndex(f => f.friendId === friendId);

            if (index === -1) {
                return res.status(404).json({ error: "Friendship not found" });
            }

            userFriends.splice(index, 1);

            return res.json({ removed: true });
        });

        // ====================================================================
        // LEADERBOARD ROUTES
        // ====================================================================

        app.get("/api/leaderboard/global", (req, res) => {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 50;

            const sortedUsers = Array.from(users.values())
                .sort((a, b) => b.elo - a.elo);

            const start = (page - 1) * limit;
            const paginated = sortedUsers.slice(start, start + limit);

            return res.json({
                players: paginated.map((u, idx) => ({
                    rank: start + idx + 1,
                    userId: u.userId,
                    username: u.username,
                    avatar: u.avatar,
                    elo: u.elo,
                    tier: u.tier,
                    trophies: u.trophies,
                })),
                total: sortedUsers.length,
            });
        });

        app.get("/api/leaderboard/weekly", (req, res) => {
            const sortedUsers = Array.from(users.values())
                .sort((a, b) => b.trophies - a.trophies)
                .slice(0, 100);

            return res.json({
                players: sortedUsers.map((u, idx) => ({
                    rank: idx + 1,
                    userId: u.userId,
                    username: u.username,
                    avatar: u.avatar,
                    trophies: u.trophies,
                    weeklyGain: Math.floor(Math.random() * 500),
                })),
            });
        });

        // ====================================================================
        // MONITORING & PLAYGROUND
        // ====================================================================

        /**
         * Use @colyseus/monitor
         * It is recommended to protect this route with a password
         */
        app.use("/monitor", monitor());

        /**
         * Use @colyseus/playground
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    },
});

export default server;
