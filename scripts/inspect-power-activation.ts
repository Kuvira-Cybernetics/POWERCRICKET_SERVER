/**
 * One-off read-only diagnostic: inspect `powerDefinitions` activation wiring.
 *
 * Confirms the field-name mismatch behind "powers not applying":
 *   - Docs store activation as a TOP-LEVEL `type: "Triggered"|"Passive"` field.
 *   - Server registry reads lowercase `settings.activation` (default "passive").
 * Also reports the shape of `powerSettings.levels[]` per-level scalars to catch
 * the "(array)" rendering the user saw in the Firestore console.
 *
 * Usage:  tsx --env-file=.env.development scripts/inspect-power-activation.ts
 *
 * Prints NO secrets and NO base64 — structural fields only.
 */
import { initFirebaseAdmin } from "../src/config/firebaseAdmin.js";
import { loadPowerDefinitions, getPowerEffect } from "../src/rooms/powers/loader.js";

const COLLECTION = "powerDefinitions";

function shape(v: any): string {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (Array.isArray(v)) return `array(${v.length})`;
    return typeof v;
}

async function main() {
    const db = initFirebaseAdmin();
    if (!db) {
        console.error("❌ No Firebase credentials configured (GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT).");
        process.exit(1);
    }

    const snap = await db.collection(COLLECTION).get();
    if (snap.empty) {
        console.warn(`[inspect] ${COLLECTION} is EMPTY — nothing seeded. Server loads 0 → all powers generic passive.`);
        process.exit(0);
    }

    const rows: any[] = [];
    snap.forEach(doc => {
        const d: any = doc.data() || {};
        const levels = d?.powerSettings?.levels;
        const l0 = Array.isArray(levels) && levels.length > 0 ? levels[0] : undefined;
        rows.push({
            id: (typeof d.powerId === "string" && d.powerId) || doc.id,
            effectType: d.effectType ?? "(none)",
            topType: d.type ?? "(none)",            // capitalized Triggered/Passive expected
            hasActivation: "activation" in d,        // top-level activation? (not expected)
            settingsActivation: d?.settings?.activation ?? "(none)",
            powerSettingsActivation: d?.powerSettings?.activation ?? "(none)",
            isEnabled: d.isEnabled,
            levelsShape: shape(levels),
            l0_level: l0 ? shape(l0.level) : "-",
            l0_cooldownSeconds: l0 ? shape(l0.cooldownSeconds) : "-",
            l0_maxUsesPerMatch: l0 ? shape(l0.maxUsesPerMatch) : "-",
            l0_removedBoxValues: l0 ? shape(l0.removedBoxValues) : "-",
        });
    });
    rows.sort((a, b) => a.id.localeCompare(b.id));

    console.log(`[inspect] ${rows.length} docs in ${COLLECTION}\n`);
    console.log("ID                        effectType            topType    settings.act  pSettings.act  enabled  levels");
    console.log("--------------------------------------------------------------------------------------------------------");
    const typeCounts: Record<string, number> = {};
    for (const r of rows) {
        typeCounts[String(r.topType)] = (typeCounts[String(r.topType)] || 0) + 1;
        console.log(
            `${r.id.padEnd(26)}${String(r.effectType).padEnd(22)}${String(r.topType).padEnd(11)}` +
            `${String(r.settingsActivation).padEnd(14)}${String(r.powerSettingsActivation).padEnd(15)}` +
            `${String(r.isEnabled).padEnd(9)}${r.levelsShape}`
        );
    }
    console.log("--------------------------------------------------------------------------------------------------------");
    console.log("top-level `type` distribution:", typeCounts);

    // Per-level scalar shapes for the first doc that has levels (spot-check the "(array)" concern).
    const withLevels = rows.find(r => r.levelsShape.startsWith("array"));
    if (withLevels) {
        console.log(`\nlevels[0] field shapes for "${withLevels.id}":`);
        console.log(`  level=${withLevels.l0_level}  cooldownSeconds=${withLevels.l0_cooldownSeconds}  ` +
                    `maxUsesPerMatch=${withLevels.l0_maxUsesPerMatch}  removedBoxValues=${withLevels.l0_removedBoxValues}`);
        console.log("  (expect: level/cooldownSeconds/maxUsesPerMatch = number; removedBoxValues = array)");
    }

    // Raw levels[] dump for spot-check docs (no secrets in levels).
    const dumpIds = ["power_control", "power_defense", "power_sledge", "power_black_and_white"];
    for (const wantId of dumpIds) {
        const doc = snap.docs.find(d => {
            const dd: any = d.data() || {};
            return ((typeof dd.powerId === "string" && dd.powerId) || d.id) === wantId;
        });
        if (!doc) { console.log(`\n[raw] ${wantId}: NOT FOUND`); continue; }
        const dd: any = doc.data() || {};
        console.log(`\n[raw] ${wantId} powerSettings.levels =`);
        console.log(JSON.stringify(dd?.powerSettings?.levels, null, 2));
    }

    // ── PRODUCTION-PATH PROOF ──────────────────────────────────────────────
    // Run the REAL server loader (loader.ts merge + type→activation bridge +
    // registry.loadSettings) against live Firestore, then read back each
    // effect's resolved activation. This is what buildPowerManifest gates on.
    console.log("\n=== loadPowerDefinitions() + getPowerEffect() — real server path ===");
    await loadPowerDefinitions(db);
    const effEffectTypes = rows.map(r => String(r.effectType)).filter(e => e && e !== "(none)");
    let triggered = 0, passive = 0;
    console.log("effectType              activation   maxUsesPerMatch");
    console.log("-----------------------------------------------------");
    for (const et of effEffectTypes) {
        const eff: any = getPowerEffect(et);
        if (eff.activation === "triggered") triggered++; else if (eff.activation === "passive") passive++;
        console.log(`${et.padEnd(24)}${String(eff.activation).padEnd(13)}${eff.maxUsesPerMatch}`);
    }
    console.log("-----------------------------------------------------");
    console.log(`RESOLVED: triggered=${triggered}  passive=${passive}  (expect triggered=12, passive=9)`);
    console.log(triggered === 12 && passive === 9
        ? "✅ Activation bridge WORKS — 12 triggered powers will surface in buildPowerManifest."
        : "❌ Activation mismatch — bridge not resolving as expected.");

    process.exit(0);
}

main().catch(err => {
    console.error("[inspect] Failed:", err);
    process.exit(1);
});
