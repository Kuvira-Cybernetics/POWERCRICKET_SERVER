/**
 * Seed `powerDefinitions/*.powerSettings.levels[]` for ALL 21 powers with a
 * per-level apply-percentage model.
 *
 * Model (per user spec 2026-05-24):
 *   - Each level carries `applyPercentage` ramping 25 → 50 → 75 → 100 (L4 = full).
 *   - The effect value = applyPercentage% of the power's MAX effect (the L4 value).
 *       • multiplier-up   (BoundaryMaster/SuperFastBall/Googly): 1 + pct*(max-1)
 *       • multiplier-down (EagleEye):                            1 - pct*(1-min)
 *       • zero-based float (ColourCode/Defense):                 pct*max
 *       • integer count:                                         round(pct*max), min 1
 *       • inverse integer (CenturyMaster/ExtraBall):             explicit (lower = stronger)
 *       • categorical (Control/Confusion):                       explicit per-level value
 *   - Powers with no level differentiation (BlackAndWhite) → ONE level @ 100%.
 *   - Power doc gets minPercentage (L1) + maxPercentage (L4).
 *   - Exact effect fields + maxUsesPerMatch + cooldownSeconds are PRESERVED so the
 *     existing C#/server effect code keeps reading the same field names.
 *
 * Write is a MERGE on powerSettings only — `type`/`effectType`/`isEnabled`/images
 * are untouched. Bumps gameVersions/catalog.{powersVersion,powersUpdatedAt} per
 * CLAUDE.md Rule #14 so Unity drift-detection picks it up.
 *
 * Usage:  tsx --env-file=.env.development scripts/seed-power-levels.ts [--dry-run]
 */
import admin from "firebase-admin";
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";

type Level = Record<string, any>;
interface PowerSpec {
    powerId: string;
    effectType: string;
    /** extra powerSettings fields to preserve/set (e.g. Defense.minimumWidthMultiplier) */
    powerWide?: Record<string, any>;
    levels: Level[];
}

// Triggered powers carry per-level use caps (mirrors seedFirestore.ts).
const T = { maxUsesPerMatch: 3, cooldownSeconds: 0 };          // generic triggered
const T1 = { maxUsesPerMatch: 1, cooldownSeconds: 0 };         // BoundaryLegend (1 use)
const CC = { maxUsesPerMatch: 999, cooldownSeconds: 0 };       // ColourCode (always-on)
const PCT = [25, 50, 75, 100];

/** 4-level builder: applyPercentage ramp + one effect field + optional extra per-level keys. */
function lv4(field: string, values: [number, number, number, number], extra: Record<string, any> = {}): Level[] {
    return PCT.map((p, i) => ({ level: i + 1, applyPercentage: p, [field]: values[i], ...extra }));
}

const POWERS: PowerSpec[] = [
    // ── Batting ──────────────────────────────────────────────────────────────
    // multiplier-up: 1 + pct*(2.00-1) → 1.25/1.50/1.75/2.00
    { powerId: "power_boundary_master", effectType: "BoundaryMaster",
      levels: lv4("widthMultiplier", [1.25, 1.50, 1.75, 2.00], T) },
    // multiplier-down: 1 - pct*(1-0.80) → 0.95/0.90/0.85/0.80 (max slowdown @ L4)
    { powerId: "power_eagle_eye", effectType: "EagleEye",
      levels: lv4("speedMultiplier", [0.95, 0.90, 0.85, 0.80], T) },
    // zero-based float: pct*1.00 → 0.25/0.50/0.75/1.00
    { powerId: "power_colour_code", effectType: "ColourCode",
      levels: lv4("intensity", [0.25, 0.50, 0.75, 1.00], CC) },
    // integer max4: round(pct*4) → 1/2/3/4
    { powerId: "power_rotate_strike", effectType: "RotateStrike",
      levels: lv4("sixesAdded", [1, 2, 3, 4]) },
    // integer max5: round(pct*5) → 1/3/4/5
    { powerId: "power_sr_master", effectType: "SRMaster",
      levels: lv4("guaranteedBoundaryBalls", [2, 3, 4, 5]) },
    // integer max6: round(pct*6) → 2/3/5/6  (was 3/4/5/6 — shifted to fit clean ramp)
    { powerId: "power_boundary_legend", effectType: "BoundaryLegend",
      levels: lv4("forcedBoundaryBalls", [3, 4, 5, 6], T1) },
    // integer max4 → 1/2/3/4
    { powerId: "power_sledge", effectType: "Sledge",
      levels: lv4("freeHitBalls", [1, 2, 3, 4], T) },
    // two integer fields max4 → 1/2/3/4
    { powerId: "power_powerplay_master", effectType: "PowerPlayMaster",
      levels: PCT.map((p, i) => ({ level: i + 1, applyPercentage: p,
          boundariesAddedPerBall: [1, 2, 3, 4][i], wicketsRemovedPerBall: [1, 2, 3, 4][i] })) },
    // inverse integer: fewer sixes required = stronger; L4 = 1 (kept from seed)
    { powerId: "power_extra_ball", effectType: "ExtraBall",
      levels: lv4("sixesRequired", [3, 2, 1, 1]) },
    // inverse integer: lower runs threshold = stronger; ramp maps linearly 30/25/20/15
    { powerId: "power_century_master", effectType: "CenturyMaster",
      levels: lv4("runsThreshold", [30, 25, 20, 15]) },

    // ── Bowling ──────────────────────────────────────────────────────────────
    { powerId: "power_super_fast_ball", effectType: "SuperFastBall",
      levels: lv4("speedMultiplier", [1.25, 1.50, 1.75, 2.00], T) },
    { powerId: "power_googly", effectType: "Googly",
      levels: lv4("bounceSpeedMultiplier", [1.25, 1.50, 1.75, 2.00], T) },
    // integer max6: round(pct*6) → 2/3/5/6  (was 3/4/5/6 — shifted)
    { powerId: "power_wicket_master", effectType: "WicketMaster",
      levels: lv4("runDeductionPerWicket", [3, 4, 5, 6]) },
    { powerId: "power_bait", effectType: "Bait",
      levels: lv4("wicketsPerBoundary", [1, 2, 3, 4], T) },
    // categorical: removed-box sets grow per level
    { powerId: "power_control", effectType: "Control",
      levels: PCT.map((p, i) => ({ level: i + 1, applyPercentage: p,
          removedBoxValues: ["4", "4,6", "4,6,12", "4,6,12,3"][i], ...T })) },
    // integer max5: round(pct*5) → 1/3/4/5  (was 2/3/4/5 — shifted)
    { powerId: "power_revenge", effectType: "Revenge",
      levels: lv4("wicketsInserted", [2, 3, 4, 5]) },
    { powerId: "power_fiery_start", effectType: "FieryStart",
      levels: lv4("wicketsInserted", [2, 3, 4, 5]) },
    { powerId: "power_aggression", effectType: "Aggression",
      levels: lv4("pairsInserted", [1, 2, 3, 4], T) },
    // categorical: scramble mode escalates per level
    { powerId: "power_confusion", effectType: "Confusion",
      levels: PCT.map((p, i) => ({ level: i + 1, applyPercentage: p,
          scrambleMode: ["swap_4_w", "swap_4_w_6_d", "full_shuffle", "shuffle_with_inversion"][i], ...T })) },
    // zero-based float: pct*0.40 → 0.10/0.20/0.30/0.40; keep power-wide floor
    { powerId: "power_defense", effectType: "Defense", powerWide: { minimumWidthMultiplier: 0.05 },
      levels: lv4("widthReductionPerWicket", [0.10, 0.20, 0.30, 0.40]) },
    // level-less binary → single full level @ 100%
    { powerId: "power_black_and_white", effectType: "BlackAndWhite",
      levels: [{ level: 1, applyPercentage: 100 }] },
];

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const db = initFirebaseAdmin();
    if (!db) { console.error("❌ No Firebase credentials."); process.exit(1); }

    console.log(`\n=== Seeding powerDefinitions levels (${POWERS.length} powers)${dryRun ? "  [DRY RUN]" : ""} ===\n`);

    let written = 0;
    for (const p of POWERS) {
        const minPercentage = p.levels[0].applyPercentage;
        const maxPercentage = p.levels[p.levels.length - 1].applyPercentage;
        const powerSettings: Record<string, any> = {
            ...(p.powerWide ?? {}),
            minPercentage,
            maxPercentage,
            levels: p.levels,
        };

        // Audit print
        const summary = p.levels.map(l => {
            const fld = Object.keys(l).find(k => k !== "level" && k !== "applyPercentage"
                && k !== "maxUsesPerMatch" && k !== "cooldownSeconds");
            return `L${l.level}:${l.applyPercentage}%${fld ? `=${l[fld]}` : ""}`;
        }).join("  ");
        console.log(`${p.powerId.padEnd(26)} ${summary}`);

        if (!dryRun) {
            await db.collection("powerDefinitions").doc(p.powerId).set(
                { powerSettings }, { merge: true }
            );
            written++;
        }
    }

    if (!dryRun) {
        await db.collection("gameVersions").doc("catalog").set({
            powersVersion: admin.firestore.FieldValue.increment(1),
            powersUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log(`\n✅ Wrote ${written} powers + bumped gameVersions/catalog (powersVersion +1, powersUpdatedAt=serverTimestamp).`);
        console.log("   Unity drift-detection will pick this up on next launch / Settings → Refresh Content.");
    } else {
        console.log("\n[dry-run] No writes performed. Re-run without --dry-run to seed.");
    }
    process.exit(0);
}

main().catch(err => { console.error("[seed-power-levels] Failed:", err); process.exit(1); });
