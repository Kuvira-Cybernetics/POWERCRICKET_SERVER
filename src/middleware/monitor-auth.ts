import type { RequestHandler } from "express";
import { timingSafeEqual } from "crypto";

/**
 * HTTP Basic Auth middleware for the /monitor dashboard.
 *
 * Credentials come from env vars `MONITOR_USER` and `MONITOR_PASS`. If either
 * is unset, the middleware refuses all requests — fail closed, never open.
 *
 * Only intended for mounting in front of `@colyseus/monitor` when
 * `NODE_ENV === "production"`. Dev environments should keep the monitor
 * unauthenticated so the playground/Colyseus-SDK can iterate fast.
 */
export function monitorAuth(): RequestHandler {
    return (req, res, next) => {
        const user = process.env.MONITOR_USER;
        const pass = process.env.MONITOR_PASS;

        if (!user || !pass) {
            res.status(503).send("monitor credentials not configured");
            return;
        }

        const hdr = req.headers["authorization"];
        if (!hdr || !hdr.startsWith("Basic ")) {
            res.set("WWW-Authenticate", 'Basic realm="colyseus-monitor"');
            res.status(401).send("auth required");
            return;
        }

        let decoded: string;
        try {
            decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
        } catch {
            res.status(400).send("malformed authorization header");
            return;
        }

        const idx = decoded.indexOf(":");
        if (idx < 0) {
            res.status(400).send("malformed credentials");
            return;
        }
        const suppliedUser = decoded.slice(0, idx);
        const suppliedPass = decoded.slice(idx + 1);

        // Constant-time comparison to avoid timing side-channels.
        if (safeEqual(suppliedUser, user) && safeEqual(suppliedPass, pass)) {
            next();
            return;
        }
        res.set("WWW-Authenticate", 'Basic realm="colyseus-monitor"');
        res.status(401).send("invalid credentials");
    };
}

/** Length-insensitive constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    // Pad shorter to longer so timingSafeEqual runs on equal-length buffers.
    const len = Math.max(ab.length, bb.length);
    const ap  = Buffer.alloc(len, 0); ab.copy(ap);
    const bp  = Buffer.alloc(len, 0); bb.copy(bp);
    const ok = timingSafeEqual(ap, bp);
    return ok && ab.length === bb.length;
}
