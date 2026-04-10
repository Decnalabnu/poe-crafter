import itemsData from "../data/items.json";
import essenceDataList from "../data/essences.json";
import fossilData from "../data/fossils.json";
import economyData from "../data/active_economy.json";

// Recombinator pool probabilities used:
// pool=2: P(keep2) = 1/3
// pool=4: P(keep3) = 1/4, P(selected={A,B,C}|keep3) = 2/4 → P(ABC) = 1/8

// ---------------------------------------------------------------------------
// calculateRecombEV
//
// Models the 3-phase recomb chain targeting 3 specific T1 affixes:
//   Phase 1 — alt-roll single-affix magic items (A, B, C)
//   Phase 2 — recomb (A+B) and (B+C) to get 2-affix intermediates AB and BC
//   Phase 3 — final recomb (AB+BC) with B as double-ticket overlap to get ABC
//
// All three modIds must be the same type (all prefixes or all suffixes).
// The middle mod (modIds[1]) is the overlap that appears on both intermediates.
// ---------------------------------------------------------------------------
export function calculateRecombEV({
  itemClass,
  modIds,          // [idA, idB, idC] — B is the overlap mod
  recombCostChaos,
  altCostChaos,
  influence = null,
}) {
  const pool = itemsData[itemClass];
  if (!pool) return { error: `Invalid item class: ${itemClass}` };

  const influenceFilter = (m) => !m.influence || m.influence === influence;
  const allPrefixes = pool.prefixes.filter(influenceFilter);
  const allSuffixes = pool.suffixes.filter(influenceFilter);

  // Resolve each mod ID → mod object
  const resolvedMods = modIds.map((id) => {
    const p = allPrefixes.find((m) => m.id === id);
    if (p) return { ...p, isPrefix: true };
    const s = allSuffixes.find((m) => m.id === id);
    if (s) return { ...s, isPrefix: false };
    return null;
  });

  if (resolvedMods.some((m) => m === null))
    return { error: "One or more mods not found in the item pool." };

  const allPrefix = resolvedMods.every((m) => m.isPrefix);
  const allSuffix = resolvedMods.every((m) => !m.isPrefix);
  if (!allPrefix && !allSuffix)
    return { error: "All three mods must be the same type (all prefixes or all suffixes)." };

  const isPrefix = allPrefix;
  const relevantPool = isPrefix ? allPrefixes : allSuffixes;
  const totalPoolWeight = relevantPool.reduce(
    (sum, m) => sum + (m.spawn_weights?.[0]?.weight || 0),
    0,
  );

  // Phase 1 — alt-roll cost per single-mod magic item
  // P(target mod appears as a prefix/suffix on a magic alt) ≈ 0.75 × w / totalW
  // (75% of magic items have the relevant slot type)
  const singleModCosts = resolvedMods.map((mod) => {
    const w = mod.spawn_weights?.[0]?.weight || 0;
    if (w === 0) return { error: `Mod "${mod.group}" has zero spawn weight.` };
    const pPerAlt = 0.75 * w / totalPoolWeight;
    const expectedAlts = 1 / pPerAlt;
    return {
      modId: mod.id,
      group: mod.group,
      tier: mod.tier,
      weight: w,
      weightPct: (w / totalPoolWeight * 100).toFixed(2),
      expectedAlts: Math.round(expectedAlts),
      altCost: expectedAlts * altCostChaos,
    };
  });

  if (singleModCosts.some((c) => c.error)) {
    return { error: singleModCosts.find((c) => c.error).error };
  }

  const [costA, costB, costC] = singleModCosts;

  // Phase 2 — recomb pairs
  // Pool = {A, B} or {B, C}: 2 prefixes total, need keep-2 ≈ 33.3%
  const P_phase2 = 1 / 3;
  const E_phase2 = 1 / P_phase2; // ~3 attempts per pair

  // Each failed phase 2 attempt consumes both input single-mod items.
  // Expected single-mod items consumed per pair = E_phase2 each.
  const costPerAB = E_phase2 * (costA.altCost + costB.altCost + recombCostChaos);
  const costPerBC = E_phase2 * (costB.altCost + costC.altCost + recombCostChaos);

  // Phase 3 — final recomb (AB + BC)
  // Prefix pool = {A, B, B, C} (B is double-ticket)
  // P(keep 3 from pool of 4) = 25%
  // P(selected 3 = {A,B,C} | keep 3) = 2/4 = 50% (must skip one of the two B tickets)
  const P_phase3 = (1 / 4) * (1 / 2); // = 12.5%
  const E_phase3 = 1 / P_phase3;      // = 8 attempts

  // Each failed phase 3 attempt consumes one AB + one BC item (which must be re-crafted).
  const totalCostChaos = E_phase3 * (costPerAB + costPerBC + recombCostChaos);

  return {
    isPrefix,
    mods: singleModCosts,
    phase1: {
      details: singleModCosts.map((c) => ({
        group: c.group,
        tier: c.tier,
        weightPct: c.weightPct,
        expectedAlts: c.expectedAlts,
        altCost: c.altCost,
      })),
    },
    phase2: {
      pSuccess: (P_phase2 * 100).toFixed(1),
      expectedAttempts: Math.round(E_phase2),
      costPerAB,
      costPerBC,
    },
    phase3: {
      pSuccess: (P_phase3 * 100).toFixed(1),
      expectedAttempts: Math.round(E_phase3),
    },
    totalCostChaos,
    totalCostDivines: totalCostChaos / (economyData.divine_price || 150),
  };
}

// Chaos Orb / Alchemy mod-count distribution (no fracture, no essence):
//   4 mods = 8/12 ≈ 66.7%,  5 mods = 3/12 = 25%,  6 mods = 1/12 ≈ 8.3%
// Source: PoE wiki 8:3:1 ratio. Calibrated against CoE: chaos no-frac single ES% → ceil=14 (CoE:14).
// Within each count, prefix/suffix split is uniform over valid (P,S) pairs.
const CHAOS_CONFIGS = [
  { p: 1, s: 3, prob: 8 / 36 },
  { p: 2, s: 2, prob: 8 / 36 },
  { p: 3, s: 1, prob: 8 / 36 },
  { p: 2, s: 3, prob: 3 / 24 },
  { p: 3, s: 2, prob: 3 / 24 },
  { p: 3, s: 3, prob: 1 / 12 },
];
const ALCH_CONFIGS = CHAOS_CONFIGS;

// Chaos Orb with a fractured mod present:
//   Empirically, CoE matches the old equal-weight distribution (4=50%, 5=33%, 6=17%).
//   Calibrated against CoE: frac+single ES% → ceil=19 vs CoE=18 (Δ≈6%); frac+2×ES → 538 vs 550 (Δ≈2%).
//   Using 50/33/17 (uniform 1/6) is more accurate here than 8:3:1 because the fracture
//   pre-occupies one prefix slot, shifting which configs can contribute, and the effective
//   distribution of usable configs aligns better with the equal-weight split.
const FRACTURE_CONFIGS = [
  { p: 1, s: 3, prob: 1 / 6 },
  { p: 2, s: 2, prob: 1 / 6 },
  { p: 3, s: 1, prob: 1 / 6 },
  { p: 2, s: 3, prob: 1 / 6 },
  { p: 3, s: 2, prob: 1 / 6 },
  { p: 3, s: 3, prob: 1 / 6 },
];

// Essence mod-count distribution. Essences guarantee one mod, which occupies one of the
// N total mod slots — leaving N-1 slots for random draws. The total mod count still follows
// 8:3:1 (4/5/6-mod), but random draws = N-1. The guaranteed mod is always a suffix for
// body armour (cold resist, life regen etc), so random prefix/suffix splits shift accordingly.
//   4-mod item → 3 random: (1P,2S),(2P,1S),(3P,0S) each 8/36
//   5-mod item → 4 random: (1P,3S),(2P,2S),(3P,1S) each 3/36 = 1/12
//   6-mod item → 5 random: (2P,3S),(3P,2S)         each 1/24
// Calibrated against Craft of Exile: essence+no-frac single ES% target → ceil=15 (CoE: 15).
const ESSENCE_CONFIGS = [
  { p: 1, s: 2, prob: 8 / 36 },
  { p: 2, s: 1, prob: 8 / 36 },
  { p: 3, s: 0, prob: 8 / 36 },
  { p: 1, s: 3, prob: 1 / 12 },
  { p: 2, s: 2, prob: 1 / 12 },
  { p: 3, s: 1, prob: 1 / 12 },
  { p: 2, s: 3, prob: 1 / 24 },
  { p: 3, s: 2, prob: 1 / 24 },
];

// Resonators (Fossils) mod-count distribution. Calibrated empirically against
// Craft of Exile reference data: 4 mods = 3/12 (25%), 5 mods = 4/12 (33%), 6 mods = 5/12 (42%).
// Used when fossils are active WITHOUT a fractured mod.
// When fossils + fracture are combined, FRACTURE_CONFIGS is used instead (better calibration
// for suffix targets: Dense+Frigid+frac+2ES+cold → 594 vs CoE 493 vs FOSSIL_CONFIGS 392).
const FOSSIL_CONFIGS = [
  { p: 1, s: 3, prob: 3 / 36 },
  { p: 2, s: 2, prob: 3 / 36 },
  { p: 3, s: 1, prob: 3 / 36 }, // 4 mods (9/36 = 3/12 = 1/4)
  { p: 2, s: 3, prob: 4 / 24 },
  { p: 3, s: 2, prob: 4 / 24 }, // 5 mods (8/24 = 4/12 = 1/3)
  { p: 3, s: 3, prob: 5 / 12 }, // 6 mods (5/12)
];

export function getSmartWeight(m, armourBaseTag) {
  let w = 0;
  if (armourBaseTag && m.base_weights) {
    w = m.base_weights[armourBaseTag] || 0;
  } else if (m.spawn_weights && m.spawn_weights.length > 0) {
    w = Math.max(...m.spawn_weights.map(sw => sw.weight));
  }

  // Smart filtering for missing base_weights (which RePoE drops to save space)
  if (armourBaseTag && !m.base_weights) {
    const tags = m.mod_tags || [];
    const isArmour = tags.includes("armour");
    const isEvasion = tags.includes("evasion");
    const isES = tags.includes("energy_shield");

    // If the mod is a defensive mod, enforce base type matching
    if (isArmour || isEvasion || isES) {
      const allowsArmour = armourBaseTag.includes("str");
      const allowsEvasion = armourBaseTag.includes("dex");
      const allowsES = armourBaseTag.includes("int");

      if (isArmour && !allowsArmour) return 0;
      if (isEvasion && !allowsEvasion) return 0;
      if (isES && !allowsES) return 0;
    }
  }
  return w;
}

function applyFossilMultipliers(pool, activeFossilIds) {
  if (!activeFossilIds || activeFossilIds.length === 0) return pool;

  return pool
    .map((mod) => {
      // Mods with 0 weight (fractured/essence-only pre-placed mods) are kept as-is.
      // Applying multipliers to them would still yield 0, and they must survive so
      // the fractured mod lookup in calculateSpamEV can find them.
      if (mod.weight === 0) return { ...mod, _preplacedZero: true };

      let finalWeight = mod.weight;

      activeFossilIds.forEach((fossilId) => {
        const fossil = fossilData[fossilId];
        if (!fossil) return;

        let totalMultiplier = 1;
        let hasZeroMultiplier = false;

        (mod.mod_tags || []).forEach((tag) => {
          if (fossil.multipliers[tag] !== undefined) {
            const mult = fossil.multipliers[tag];
            if (mult === 0) hasZeroMultiplier = true;
            else totalMultiplier *= mult; // Fossil multipliers compound in PoE
          }
        });

        if (hasZeroMultiplier) finalWeight = 0;
        else finalWeight *= totalMultiplier;
      });

      return { ...mod, weight: finalWeight };
    })
    .filter((mod) => mod.weight > 0 || mod._preplacedZero);
}

// Returns true if mod m (with a .tier field from items.json) satisfies targetMod.
// Lower tier number = better roll, so T1 satisfies a T2 requirement.
// Falls back to exact id match for mods without tier data.
function modSatisfiesTarget(m, targetMod) {
  if (m.group !== targetMod.group) return false;
  if (m.tier !== undefined && targetMod.tier !== undefined) {
    return m.tier <= targetMod.tier;
  }
  return m.id === targetMod.id;
}

// ---------------------------------------------------------------------------
// Exact independent pool probability engine
// ---------------------------------------------------------------------------
function exactProbSinglePool(
  targetsMask,
  drawsLeft,
  ntWeights,
  targetGroups,
  memo,
) {
  if (targetsMask === 0) return 1.0;
  if (drawsLeft === 0) return 0.0;

  let targetsRemaining = 0;
  for (let i = 0; i < targetGroups.length; i++) {
    if (targetsMask & (1 << i)) targetsRemaining++;
  }
  if (targetsRemaining > drawsLeft) return 0.0;

  const key = `${targetsMask},${drawsLeft},${ntWeights.join(',')}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let totalW = 0;
  for (let j = 0; j < ntWeights.length; j++) totalW += ntWeights[j];
  for (let i = 0; i < targetGroups.length; i++) {
    if (targetsMask & (1 << i)) {
      totalW += targetGroups[i].groupTotalWeight;
    }
  }

  if (totalW === 0) {
    memo.set(key, 0.0);
    return 0.0;
  }

  let result = 0;

  // Branch 1: Draw a target
  for (let i = 0; i < targetGroups.length; i++) {
    if (!(targetsMask & (1 << i))) continue;
    const pQualify = targetGroups[i].effectiveWeight / totalW;
    if (pQualify > 0) {
      result +=
        pQualify *
        exactProbSinglePool(
          targetsMask & ~(1 << i),
          drawsLeft - 1,
          ntWeights,
          targetGroups,
          memo,
        );
    }
  }

  // Branch 2: Draw a non-target
  if (ntWeights.length > 0) {
    const seen = new Set();
    for (let j = 0; j < ntWeights.length; j++) {
      const w = ntWeights[j];
      if (seen.has(w)) continue;
      seen.add(w);
      let cnt = 0;
      for (let k = 0; k < ntWeights.length; k++) if (ntWeights[k] === w) cnt++;
      
      const pDraw = (w * cnt) / totalW;
      const newNt = ntWeights.slice();
      newNt.splice(newNt.indexOf(w), 1);
      result +=
        pDraw *
        exactProbSinglePool(
          targetsMask,
          drawsLeft - 1,
          newNt,
          targetGroups,
          memo,
        );
    }
  }

  memo.set(key, result);
  return result;
}

// armourBaseTag: e.g. "int_armour", "str_armour", "dex_armour", "str_int_armour", etc.
// When set, each armour-slot mod's effective weight = max(base_weights.body_armour, base_weights[armourBaseTag])
// Mods where that value = 0 are excluded from the pool.
// When null, falls back to spawn_weights[0].weight (max across all aliases — current behaviour).
//
// itemLevel: filters out mods whose required_level > itemLevel (same as how PoE works).
// Default null = no filtering (assume iLvl 100 / all tiers available).
export function calculateSpamEV(
  targetIds = [],
  essenceId = "deafening_essence_of_spite", // null = chaos spam (1c/try, no guaranteed mod)
  itemTag = "ring",
  fracturedModId = "none",
  activeFossils = [],
  influence = null,
  armourBaseTag = null,
  itemLevel = null,
) {
  // Dynamically infer the armourBaseTag if the UI doesn't provide one (prevents 100k+ pool bloat)
  if (!armourBaseTag && ["body_armour", "helmet", "boots", "gloves"].includes(itemTag)) {
    const hints = [...targetIds, fracturedModId].filter(id => id && id !== "none");
    let isStr = false, isDex = false, isInt = false;
    const pool = itemsData[itemTag];
    if (pool) {
      const allMods = [...pool.prefixes, ...pool.suffixes];
      for (const id of hints) {
        const mod = allMods.find(m => m.id === id);
        if (mod && mod.mod_tags) {
          if (mod.mod_tags.includes("armour")) isStr = true;
          if (mod.mod_tags.includes("evasion")) isDex = true;
          if (mod.mod_tags.includes("energy_shield")) isInt = true;
        }
      }
    }
    if (isStr || isDex || isInt) {
      const parts = [];
      if (isStr) parts.push("str");
      if (isDex) parts.push("dex");
      if (isInt) parts.push("int");
      armourBaseTag = parts.join("_") + "_armour";
    } else {
      armourBaseTag = "int_armour"; // safe fallback for pure ES tests like Twilight Regalia if no hints exist
    }
  }

  const essence = essenceId ? essenceDataList[essenceId] : null;
  let costPerTry = 1;

  if (activeFossils.length > 0) {
    costPerTry = activeFossils.reduce(
      (sum, fId) => sum + (economyData.fossils[fId] || 1),
      0,
    );
    costPerTry += 2;
  } else if (essenceId) {
    costPerTry = economyData.essences[essenceId] || 3;
  }
  // else: chaos spam — costPerTry stays 1

  const isFossil = activeFossils.length > 0;
  const isEssence = !isFossil && !!essenceId;
  const isFractured = !isFossil && fracturedModId !== "none";
  const isFossilFractured = isFossil && fracturedModId !== "none";
  const configs = isFossilFractured ? FRACTURE_CONFIGS
    : isFossil ? FOSSIL_CONFIGS
    : isEssence ? ESSENCE_CONFIGS
    : isFractured ? FRACTURE_CONFIGS
    : CHAOS_CONFIGS;

  // Guaranteed mod is looked up by group name (guaranteed_mod_groups) so it stays
  // stable even when item mod IDs change. Falls back to legacy ID lookup.
  const guaranteedModGroup =
    activeFossils.length > 0 ? null : essence?.guaranteed_mod_groups?.[itemTag] ?? null;
  const guaranteedModId =
    activeFossils.length > 0 ? null : essence?.guaranteed_mods?.[itemTag];

  if (targetIds.length === 0) {
    return {
      probability: "100.0000%",
      averageTries: 1,
      expectedCostChaos: costPerTry,
    };
  }

  const activePool = itemsData[itemTag];
  if (!activePool) return { error: `Invalid item class: ${itemTag}` };

  // Include a mod if it's a base mod (no influence) or matches selected influence.
  // Mods with a different influence never spawn, even on influenced items.
  const influenceFilter = (m) =>
    !m.influence || m.influence === influence;

  // Exclude mods whose required_level exceeds the item's level.
  // Pre-placed mods (fractured/essence) bypass this — they're already on the item.
  const iLvlOk = (m) =>
    itemLevel === null || (m.required_level ?? 0) <= itemLevel;

  const resolveWeight = (m) => {
    return getSmartWeight(m, armourBaseTag);
  };

  let validPrefixes = activePool.prefixes
    .filter(influenceFilter)
    .filter((m) => iLvlOk(m) || m.id === fracturedModId || m.id === guaranteedModId)
    .map((m) => ({
      id: m.id,
      group: m.group,
      tier: m.tier,
      weight: resolveWeight(m),
      isPrefix: true,
      mod_tags: m.mod_tags || [],
      influence: m.influence || null,
    }))
    .filter(
      (m) =>
        m.weight > 0 || m.group === guaranteedModGroup || m.id === guaranteedModId || m.id === fracturedModId,
    );

  let validSuffixes = activePool.suffixes
    .filter(influenceFilter)
    .filter((m) => iLvlOk(m) || m.id === fracturedModId || m.id === guaranteedModId)
    .map((m) => ({
      id: m.id,
      group: m.group,
      tier: m.tier,
      weight: resolveWeight(m),
      isPrefix: false,
      mod_tags: m.mod_tags || [],
      influence: m.influence || null,
    }))
    .filter(
      (m) =>
        m.weight > 0 || m.group === guaranteedModGroup || m.id === guaranteedModId || m.id === fracturedModId,
    );

  validPrefixes = applyFossilMultipliers(validPrefixes, activeFossils);
  validSuffixes = applyFossilMultipliers(validSuffixes, activeFossils);

  let gMod = null;
  if (guaranteedModGroup || guaranteedModId) {
    // Prefer group-based lookup (T1 of that group); fall back to legacy ID
    gMod =
      validPrefixes.find((m) => m.group === guaranteedModGroup && m.tier === 1) ||
      validSuffixes.find((m) => m.group === guaranteedModGroup && m.tier === 1) ||
      validPrefixes.find((m) => m.id === guaranteedModId) ||
      validSuffixes.find((m) => m.id === guaranteedModId);
    if (!gMod)
      return { error: "Guaranteed mod not found in valid pool for this item." };
  }

  let fMod = null;
  if (fracturedModId !== "none") {
    fMod =
      validPrefixes.find((m) => m.id === fracturedModId) ||
      validSuffixes.find((m) => m.id === fracturedModId);
    if (!fMod) return { error: "Fractured mod not found." };
    if (gMod && fMod.group === gMod.group)
      return {
        error: "Essence and Fracture cannot belong to the same mod group.",
      };
  }

  // Pre-placed mods consume slots and cannot roll again
  const prePlaced = [];
  if (gMod) prePlaced.push(gMod);
  if (fMod) prePlaced.push(fMod);

  const prePlacedGroups = new Set(prePlaced.map((m) => m.group));
  const rollablePrefixes = validPrefixes.filter(
    (m) => !prePlacedGroups.has(m.group),
  );
  const rollableSuffixes = validSuffixes.filter(
    (m) => !prePlacedGroups.has(m.group),
  );

  // Resolve each target ID to its mod object so tier comparisons work.
  // If a mod is missing from the pool (e.g. suppressed to 0 by a fossil), that target
  // is impossible — return an error rather than falling through to the "no targets = 100%" path.
  const allValidMods = [...validPrefixes, ...validSuffixes];
  const resolvedTargetMods = targetIds
    .map((tid) => allValidMods.find((m) => m.id === tid))
    .filter(Boolean);

  if (resolvedTargetMods.length < targetIds.length) {
    const missing = targetIds.filter((tid) => !allValidMods.find((m) => m.id === tid));
    return { error: `Target mod(s) suppressed to zero weight (incompatible fossil or mod not in pool): ${missing.join(", ")}` };
  }

  // Targets already satisfied by pre-placed mods are removed from requirements
  const remainingTargetMods = resolvedTargetMods.filter(
    (targetMod) => !prePlaced.some((pm) => modSatisfiesTarget(pm, targetMod)),
  );

  // Fracture pre-places a mod and reduces the random draw count (handled via prePlaced* offsets
  // into CHAOS_CONFIGS). Essence uses ESSENCE_CONFIGS which already model N-1 random draws —
  // the guaranteed mod's slot is baked into the config, so only fracture counts as a slot offset.
  const prePlacedPrefixes = prePlaced.filter((m) => m.isPrefix && m !== gMod).length;
  const prePlacedSuffixes = prePlaced.filter((m) => !m.isPrefix && m !== gMod).length;
  const maxPrefixSlots = 3 - prePlacedPrefixes;
  const maxSuffixSlots = 3 - prePlacedSuffixes;

  if (remainingTargetMods.length === 0) {
    return {
      probability: "100.0000%",
      averageTries: 1,
      expectedCostChaos: costPerTry,
    };
  }

  // Build group total weight maps (sum of all tier weights per group)
  const prefixGroupWeights = new Map();
  for (const m of rollablePrefixes) {
    prefixGroupWeights.set(
      m.group,
      (prefixGroupWeights.get(m.group) || 0) + m.weight,
    );
  }
  const suffixGroupWeights = new Map();
  for (const m of rollableSuffixes) {
    suffixGroupWeights.set(
      m.group,
      (suffixGroupWeights.get(m.group) || 0) + m.weight,
    );
  }

  // Resolve each remaining target: find its group, qualifying weight, and full group weight
  const targetGroupDefs = [];
  for (const targetMod of remainingTargetMods) {
    let effectiveWeight = 0;
    let isPrefix = null;
    let group = null;

    for (const m of rollablePrefixes) {
      if (modSatisfiesTarget(m, targetMod)) {
        effectiveWeight += m.weight;
        isPrefix = true;
        group = m.group;
      }
    }

    if (isPrefix === null) {
      for (const m of rollableSuffixes) {
        if (modSatisfiesTarget(m, targetMod)) {
          effectiveWeight += m.weight;
          isPrefix = false;
          group = m.group;
        }
      }
    }

    if (effectiveWeight === 0 || group === null) {
      return {
        error: `Target mod not found or has zero weight: ${targetMod.id}`,
      };
    }

    const groupTotalWeight = isPrefix
      ? prefixGroupWeights.get(group) || 0
      : suffixGroupWeights.get(group) || 0;

    targetGroupDefs.push({
      effectiveWeight,
      groupTotalWeight,
      isPrefix,
      group,
    });
  }

  // Non-target group pools (exclude target groups)
  const targetPrefixGroups = new Set(
    targetGroupDefs.filter((t) => t.isPrefix).map((t) => t.group),
  );
  const targetSuffixGroups = new Set(
    targetGroupDefs.filter((t) => !t.isPrefix).map((t) => t.group),
  );

  // Sorted desc so groups with equal weight produce identical sub-arrays after removal,
  // maximising memo hits across recursive branches.
  const ntPrefixWeights = [...prefixGroupWeights.entries()]
    .filter(([g]) => !targetPrefixGroups.has(g))
    .map(([, w]) => w)
    .sort((a, b) => b - a);
  const ntSuffixWeights = [...suffixGroupWeights.entries()]
    .filter(([g]) => !targetSuffixGroups.has(g))
    .map(([, w]) => w)
    .sort((a, b) => b - a);

  const prefTargets = targetGroupDefs.filter(t => t.isPrefix);
  const suffTargets = targetGroupDefs.filter(t => !t.isPrefix);
  const prefMask = (1 << prefTargets.length) - 1;
  const suffMask = (1 << suffTargets.length) - 1;

  const prefMemo = new Map();
  const suffMemo = new Map();

  let totalProbability = 0;

  for (const config of configs) {
    const randomP = config.p - prePlacedPrefixes;
    const randomS = config.s - prePlacedSuffixes;

    if (randomP < 0 || randomS < 0) continue;
    if (randomP < prefTargets.length || randomS < suffTargets.length) continue;

    const pPref = exactProbSinglePool(prefMask, randomP, ntPrefixWeights, prefTargets, prefMemo);
    const pSuff = exactProbSinglePool(suffMask, randomS, ntSuffixWeights, suffTargets, suffMemo);

    totalProbability += config.prob * pPref * pSuff;
  }

  if (totalProbability === 0) {
    return {
      error:
        "Probability is effectively zero — impossible or near-impossible combination.",
    };
  }

  const expectedTries = Math.ceil(1 / totalProbability);
  return {
    probability: (totalProbability * 100).toFixed(4) + "%",
    averageTries: expectedTries,
    expectedCostChaos: expectedTries * costPerTry,
  };
}

// ---------------------------------------------------------------------------
// calculateHarvestEV
//
// Models a Harvest reforge (e.g. "Reforge Defence"):
//   - Costs costPerTry chaos per attempt (typically 2c)
//   - Guarantees at least one rolled mod has the specified tag
//
// The guarantee is modelled by treating the constrained pool as the full
// population. On every roll at least one mod must come from the tag-matching
// sub-pool, so we compute:
//
//   P(hit | guaranteed tag) = P(success AND ≥1 tag mod) / P(≥1 tag mod)
//
// P(≥1 tag mod) is 1 - P(zero tag mods), calculated from the weight fraction
// of tag mods vs the full pool. We then divide the raw hit probability from
// the recursive engine by this denominator — giving the conditional probability
// and a correspondingly lower expected tries count.
// ---------------------------------------------------------------------------
export function calculateHarvestEV({
  targetIds = [],
  guaranteedTag,
  itemTag = "ring",
  fracturedModId = "none",
  influence = null,
  costPerTry = 2,
  armourBaseTag = null,
  itemLevel = null,
}) {
  if (!guaranteedTag) return { error: "No guaranteed tag specified." };

  // Run the base EV as if chaos spam (tag constraint only affects the denominator)
  const base = calculateSpamEV(targetIds, null, itemTag, fracturedModId, [], influence, armourBaseTag, itemLevel);
  if (base.error) return base;

  const activePool = itemsData[itemTag];
  if (!activePool) return { error: `Invalid item class: ${itemTag}` };

  const influenceFilter = (m) => !m.influence || m.influence === influence;
  const allPrefixes = activePool.prefixes.filter(influenceFilter);
  const allSuffixes = activePool.suffixes.filter(influenceFilter);

  // Fractured mod reduces available slot count — same logic as calculateSpamEV.
  // Fix: check prefix/suffix membership directly (raw pool objects lack .isPrefix).
  const fracIsPrefix = fracturedModId !== "none" && allPrefixes.some((m) => m.id === fracturedModId);
  const fracIsSuffix = fracturedModId !== "none" && !fracIsPrefix && allSuffixes.some((m) => m.id === fracturedModId);
  const fracPrefixes = fracIsPrefix ? 1 : 0;
  const fracSuffixes = fracIsSuffix ? 1 : 0;

  // The fractured mod's group is pre-placed and cannot be re-rolled, so exclude it
  // from the denominator pool — otherwise its weight inflates pAtLeastOneTag.
  const fracGroup = fracturedModId !== "none"
    ? [...allPrefixes, ...allSuffixes].find((m) => m.id === fracturedModId)?.group ?? null
    : null;

  const resolveW = (m) => {
    if (itemLevel !== null && (m.required_level ?? 0) > itemLevel) return 0;
    return getSmartWeight(m, armourBaseTag);
  };

  // Weights of all mods that have the guaranteed tag, excluding the pre-placed frac group
  const tagPrefixW = allPrefixes
    .filter((m) => m.group !== fracGroup && (m.mod_tags || []).includes(guaranteedTag))
    .reduce((s, m) => s + resolveW(m), 0);
  const tagSuffixW = allSuffixes
    .filter((m) => m.group !== fracGroup && (m.mod_tags || []).includes(guaranteedTag))
    .reduce((s, m) => s + resolveW(m), 0);

  const totalPrefixW = allPrefixes.filter((m) => m.group !== fracGroup).reduce((s, m) => s + resolveW(m), 0);
  const totalSuffixW = allSuffixes.filter((m) => m.group !== fracGroup).reduce((s, m) => s + resolveW(m), 0);

  if (tagPrefixW + tagSuffixW === 0) {
    return { error: `No mods with tag "${guaranteedTag}" exist in the ${itemTag} pool.` };
  }

  // Probability a single random mod draw lands on the guaranteed tag
  // Weighted across prefix and suffix slots assuming equal slot distribution
  const pPrefixTagSlot = totalPrefixW > 0 ? tagPrefixW / totalPrefixW : 0;
  const pSuffixTagSlot = totalSuffixW > 0 ? tagSuffixW / totalSuffixW : 0;

  // For each mod count (4/5/6), compute P(≥1 tag mod among random slots)
  // = 1 - P(all random slots miss the tag)
  let pAtLeastOneTag = 0;
  for (const config of CHAOS_CONFIGS) {
    const randomP = config.p - fracPrefixes;
    const randomS = config.s - fracSuffixes;

    if (randomP < 0 || randomS < 0) continue;

    // Approximate: treat each slot independently
    const pMissPrefix = totalPrefixW > 0 ? Math.pow(1 - pPrefixTagSlot, randomP) : 1;
    const pMissSuffix = totalSuffixW > 0 ? Math.pow(1 - pSuffixTagSlot, randomS) : 1;
    const pAllMiss = pMissPrefix * pMissSuffix;
    pAtLeastOneTag += config.prob * (1 - pAllMiss);
  }

  if (pAtLeastOneTag <= 0) {
    return { error: `Tag "${guaranteedTag}" cannot appear on this item class.` };
  }

  // Raw hit probability from the base engine
  const rawProb = parseFloat(base.probability) / 100;

  // Conditional probability: P(hit | ≥1 tag mod) = P(hit) / P(≥1 tag mod)
  // Capped at 1.0 (if all tagged mods are targets, harvest guaranteed = hit)
  const conditionalProb = Math.min(rawProb / pAtLeastOneTag, 1.0);

  const expectedTries = Math.round(1 / conditionalProb);
  return {
    probability: (conditionalProb * 100).toFixed(4) + "%",
    averageTries: expectedTries,
    expectedCostChaos: expectedTries * costPerTry,
  };
}
