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

// Harvest-swappable resist groups: targeting any one counts as targeting all three.
const ELEMENTAL_RESIST_GROUPS = new Set([
  "Fire Resistance",
  "Cold Resistance",
  "Lightning Resistance",
]);

// PoE rare item affix count distribution — weights 1:3:2 per GGG data
const MOD_COUNT_DIST = [
  { count: 4, prob: 1 / 6 },
  { count: 5, prob: 3 / 6 },
  { count: 6, prob: 2 / 6 },
];

function applyFossilMultipliers(pool, activeFossilIds) {
  if (!activeFossilIds || activeFossilIds.length === 0) return pool;

  return pool
    .map((mod) => {
      let finalWeight = mod.weight;

      activeFossilIds.forEach((fossilId) => {
        const fossil = fossilData[fossilId];
        if (!fossil) return;

        let highestMultiplier = 1;
        let hasZeroMultiplier = false;

        (mod.mod_tags || []).forEach((tag) => {
          if (fossil.multipliers[tag] !== undefined) {
            const mult = fossil.multipliers[tag];
            if (mult === 0) hasZeroMultiplier = true;
            else if (mult > highestMultiplier) highestMultiplier = mult;
          }
        });

        if (hasZeroMultiplier) finalWeight = 0;
        else finalWeight *= highestMultiplier;
      });

      return { ...mod, weight: finalWeight };
    })
    .filter((mod) => mod.weight > 0);
}

// Returns true if mod m (with a .tier field from items.json) satisfies targetMod.
// Lower tier number = better roll, so T1 satisfies a T2 requirement.
// Falls back to exact id match for mods without tier data.
function modSatisfiesTarget(m, targetMod) {
  const bothElemental = ELEMENTAL_RESIST_GROUPS.has(m.group) && ELEMENTAL_RESIST_GROUPS.has(targetMod.group);
  if (!bothElemental && m.group !== targetMod.group) return false;
  if (m.tier !== undefined && targetMod.tier !== undefined) {
    return m.tier <= targetMod.tier;
  }
  return m.id === targetMod.id;
}

// ---------------------------------------------------------------------------
// Exact recursive probability engine
//
// For each draw, two outcomes are possible for a target group T:
//   1. A qualifying tier of T is selected   → target satisfied, recurse with targetsMask bit cleared
//   2. A non-qualifying tier of T is selected → this roll path can never satisfy T, contributes 0
//
// Non-target groups use a mean-field approximation: track count + average weight
// rather than enumerating every possible non-target group draw.
// This is highly accurate for typical PoE pools (50–100 non-target groups,
// roughly similar weights) and is computed in microseconds vs 500k MC iterations.
//
// State: (targetsMask, prefixLeft, suffixLeft, totalLeft, ntPrefixN, ntSuffixN)
// ---------------------------------------------------------------------------
function recursiveProb(
  targetsMask,
  prefixLeft,
  suffixLeft,
  totalLeft,
  ntPrefixN,
  ntSuffixN,
  targetGroups,
  avgNtPW, // average weight of one non-target prefix group
  avgNtSW, // average weight of one non-target suffix group
  memo,
) {
  if (targetsMask === 0) return 1.0;
  if (totalLeft === 0) return 0.0;

  // Early exit: more targets remaining than draws left
  let targetsRemaining = 0;
  for (let i = 0; i < targetGroups.length; i++) {
    if (targetsMask & (1 << i)) targetsRemaining++;
  }
  if (targetsRemaining > totalLeft) return 0.0;

  const key = `${targetsMask},${prefixLeft},${suffixLeft},${totalLeft},${ntPrefixN},${ntSuffixN}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const ntPrefixW = avgNtPW * ntPrefixN;
  const ntSuffixW = avgNtSW * ntSuffixN;

  // Total pool weight = full group weights for each pending target + non-target pool
  let totalW = 0;
  for (let i = 0; i < targetGroups.length; i++) {
    if (!(targetsMask & (1 << i))) continue;
    const tg = targetGroups[i];
    if ((tg.isPrefix && prefixLeft > 0) || (!tg.isPrefix && suffixLeft > 0)) {
      totalW += tg.groupTotalWeight; // ALL tiers compete in the pool
    }
  }
  if (prefixLeft > 0) totalW += ntPrefixW;
  if (suffixLeft > 0) totalW += ntSuffixW;

  if (totalW === 0) {
    memo.set(key, 0.0);
    return 0.0;
  }

  let result = 0;

  // Draw a qualifying tier from a target group (target satisfied)
  for (let i = 0; i < targetGroups.length; i++) {
    if (!(targetsMask & (1 << i))) continue;
    const tg = targetGroups[i];
    if ((tg.isPrefix && prefixLeft === 0) || (!tg.isPrefix && suffixLeft === 0))
      continue;

    const pQualify = tg.effectiveWeight / totalW;
    if (pQualify > 0) {
      result +=
        pQualify *
        recursiveProb(
          targetsMask & ~(1 << i),
          prefixLeft - (tg.isPrefix ? 1 : 0),
          suffixLeft - (!tg.isPrefix ? 1 : 0),
          totalLeft - 1,
          ntPrefixN,
          ntSuffixN,
          targetGroups,
          avgNtPW,
          avgNtSW,
          memo,
        );
    }
    // Non-qualifying tier of this group rolls → that target can never be satisfied
    // → probability contribution = pNonQualify * 0, so we skip it
  }

  // Draw a non-target prefix group (mean-field: remove one average-weight group)
  if (prefixLeft > 0 && ntPrefixN > 0 && ntPrefixW > 0) {
    result +=
      (ntPrefixW / totalW) *
      recursiveProb(
        targetsMask,
        prefixLeft - 1,
        suffixLeft,
        totalLeft - 1,
        ntPrefixN - 1,
        ntSuffixN,
        targetGroups,
        avgNtPW,
        avgNtSW,
        memo,
      );
  }

  // Draw a non-target suffix group (mean-field)
  if (suffixLeft > 0 && ntSuffixN > 0 && ntSuffixW > 0) {
    result +=
      (ntSuffixW / totalW) *
      recursiveProb(
        targetsMask,
        prefixLeft,
        suffixLeft - 1,
        totalLeft - 1,
        ntPrefixN,
        ntSuffixN - 1,
        targetGroups,
        avgNtPW,
        avgNtSW,
        memo,
      );
  }

  memo.set(key, result);
  return result;
}

export function calculateSpamEV(
  targetIds = [],
  essenceId = "deafening_essence_of_spite",
  itemTag = "ring",
  fracturedModId = "none",
  activeFossils = [],
  influence = null,
) {
  const essence = essenceDataList[essenceId];
  let costPerTry = 1;

  if (activeFossils.length > 0) {
    costPerTry = activeFossils.reduce(
      (sum, fId) => sum + (economyData.fossils[fId] || 1),
      0,
    );
    costPerTry += 2;
  } else {
    costPerTry = economyData.essences[essenceId] || 3;
  }

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

  let validPrefixes = activePool.prefixes
    .filter(influenceFilter)
    .map((m) => ({
      id: m.id,
      group: m.group,
      tier: m.tier,
      weight: m.spawn_weights[0]?.weight || 0,
      isPrefix: true,
      mod_tags: m.mod_tags || [],
      influence: m.influence || null,
    }))
    .filter(
      (m) =>
        m.weight > 0 || m.id === guaranteedModId || m.id === fracturedModId,
    );

  let validSuffixes = activePool.suffixes
    .filter(influenceFilter)
    .map((m) => ({
      id: m.id,
      group: m.group,
      tier: m.tier,
      weight: m.spawn_weights[0]?.weight || 0,
      isPrefix: false,
      mod_tags: m.mod_tags || [],
      influence: m.influence || null,
    }))
    .filter(
      (m) =>
        m.weight > 0 || m.id === guaranteedModId || m.id === fracturedModId,
    );

  validPrefixes = applyFossilMultipliers(validPrefixes, activeFossils);
  validSuffixes = applyFossilMultipliers(validSuffixes, activeFossils);

  let gMod = null;
  if (guaranteedModId) {
    gMod =
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

  // Resolve each target ID to its mod object so tier comparisons work
  const allValidMods = [...validPrefixes, ...validSuffixes];
  const resolvedTargetMods = targetIds
    .map((tid) => allValidMods.find((m) => m.id === tid))
    .filter(Boolean);

  // Targets already satisfied by pre-placed mods are removed from requirements
  const remainingTargetMods = resolvedTargetMods.filter(
    (targetMod) => !prePlaced.some((pm) => modSatisfiesTarget(pm, targetMod)),
  );

  const prePlacedPrefixes = prePlaced.filter((m) => m.isPrefix).length;
  const prePlacedSuffixes = prePlaced.filter((m) => !m.isPrefix).length;
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

  const ntPrefixWeights = [...prefixGroupWeights.entries()]
    .filter(([g]) => !targetPrefixGroups.has(g))
    .map(([, w]) => w);
  const ntSuffixWeights = [...suffixGroupWeights.entries()]
    .filter(([g]) => !targetSuffixGroups.has(g))
    .map(([, w]) => w);

  const ntPrefixN = ntPrefixWeights.length;
  const ntSuffixN = ntSuffixWeights.length;
  const avgNtPW =
    ntPrefixN > 0 ? ntPrefixWeights.reduce((s, w) => s + w, 0) / ntPrefixN : 0;
  const avgNtSW =
    ntSuffixN > 0 ? ntSuffixWeights.reduce((s, w) => s + w, 0) / ntSuffixN : 0;

  const initialMask = (1 << targetGroupDefs.length) - 1;
  const memo = new Map();
  let totalProbability = 0;

  for (const { count, prob } of MOD_COUNT_DIST) {
    const randomSlots = count - prePlaced.length;
    if (randomSlots < remainingTargetMods.length) continue;

    const hitProb = recursiveProb(
      initialMask,
      maxPrefixSlots,
      maxSuffixSlots,
      randomSlots,
      ntPrefixN,
      ntSuffixN,
      targetGroupDefs,
      avgNtPW,
      avgNtSW,
      memo,
    );
    totalProbability += prob * hitProb;
  }

  if (totalProbability === 0) {
    return {
      error:
        "Probability is effectively zero — impossible or near-impossible combination.",
    };
  }

  const expectedTries = Math.round(1 / totalProbability);
  return {
    probability: (totalProbability * 100).toFixed(4) + "%",
    averageTries: expectedTries,
    expectedCostChaos: expectedTries * costPerTry,
  };
}
