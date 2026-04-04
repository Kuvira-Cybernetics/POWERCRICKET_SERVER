/**
 * presence.ts — Shared online-player registry
 *
 * A single in-memory Set that all Colyseus rooms (LobbyRoom, MatchRoom)
 * write into on client join / leave.  The REST API reads from it to
 * return a real `online` flag on GET /social/friends.
 *
 * Key: the player's userId / jwtToken string (same value used by the
 *      REST layer as the Bearer token / getUserId() result).
 */
export const onlinePlayers = new Set<string>();
