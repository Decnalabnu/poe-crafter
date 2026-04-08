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

// PoE rare item affix count distribution — 5-mod items are most common (weights 1:3:2)
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
  if (m.group !== targetMod.group) return false;
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
// Non-target groups are tracked as sorted weight arrays (desc). Groups sharing
// the same weight are interchangeable, so the state folds naturally — PoE's pool
// typically has ~8 distinct weight values, giving ~165 reachable sub-multisets
// when removing up to 3 elements. This is exact, unlike the old mean-field.
//
// State: (targetsMask, prefixLeft, suffixLeft, totalLeft, ntPW_sorted, ntSW_sorted)
// ---------------------------------------------------------------------------
function recursiveProb(
  targetsMask,
  prefixLeft,
  suffixLeft,
  totalLeft,
  ntPW,          // sorted (desc) remaining non-target prefix weights
  ntSW,          // sorted (desc) remaining non-target suffix weights
  targetGroups,
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

  const key = `${targetsMask},${prefixLeft},${suffixLeft},${totalLeft},${ntPW.join(',')},|,${ntSW.join(',')}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let ntPrefixW = 0;
  for (let j = 0; j < ntPW.length; j++) ntPrefixW += ntPW[j];
  let ntSuffixW = 0;
  for (let j = 0; j < ntSW.length; j++) ntSuffixW += ntSW[j];

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
          ntPW,
          ntSW,
          targetGroups,
          memo,
        );
    }
    // Non-qualifying tier of this group rolls → that target can never be satisfied
    // → probability contribution = pNonQualify * 0, so we skip it
  }

  // Draw a non-target prefix group — exact: branch over each distinct weight value
  if (prefixLeft > 0 && ntPW.length > 0) {
    const seen = new Set();
    for (let j = 0; j < ntPW.length; j++) {
      const w = ntPW[j];
      if (seen.has(w)) continue;
      seen.add(w);
      // Count how many non-target prefix groups have this weight
      let cnt = 0;
      for (let k = 0; k < ntPW.length; k++) if (ntPW[k] === w) cnt++;
      const pDraw = (w * cnt) / totalW;
      // Remove one instance of w (array is sorted desc, splice first occurrence)
      const newNtPW = ntPW.slice();
      newNtPW.splice(newNtPW.indexOf(w), 1);
      result +=
        pDraw *
        recursiveProb(
          targetsMask,
          prefixLeft - 1,
          suffixLeft,
          totalLeft - 1,
          newNtPW,
          ntSW,
          targetGroups,
          memo,
        );
    }
  }

  // Draw a non-target suffix group — exact: branch over each distinct weight value
  if (suffixLeft > 0 && ntSW.length > 0) {
    const seen = new Set();
    for (let j = 0; j < ntSW.length; j++) {
      const w = ntSW[j];
      if (seen.has(w)) continue;
      seen.add(w);
      let cnt = 0;
      for (let k = 0; k < ntSW.length; k++) if (ntSW[k] === w) cnt++;
      const pDraw = (w * cnt) / totalW;
      const newNtSW = ntSW.slice();
      newNtSW.splice(newNtSW.indexOf(w), 1);
      result +=
        pDraw *
        recursiveProb(
          targetsMask,
          prefixLeft,
          suffixLeft - 1,
          totalLeft - 1,
          ntPW,
          newNtSW,
          targetGroups,
          memo,
        );
    }
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
        m.weight > 0 || m.group === guaranteedModGroup || m.id === guaranteedModId || m.id === fracturedModId,
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

  // Resolve each target ID to its mod object so tier comparisons work
  const allValidMods = [...validPrefixes, ...validSuffixes];
  const resolvedTargetMods = targetIds
    .map((tid) => allValidMods.find((m) => m.id === tid))
    .filter(Boolean);

  // Targets already satisfied by pre-placed mods are removed from requirements
  const remainingTargetMods = resolvedTargetMods.filter(
    (targetMod) => !prePlaced.some((pm) => modSatisfiesTarget(pm, targetMod)),
  );

  // Only fractured mods physically reduce the random slot cap — the item base
  // already has them, so the engine draws random mods into the remaining capacity.
  // Essence mods consume a slot from the total count (randomSlots = K-1) but the
  // random draws still see full 3P/3S capacity because the essence slot is reserved
  // by count, not by type cap. (This matches Craft of Exile's verified model.)
  const fracPrefixes = fMod && fMod.isPrefix ? 1 : 0;
  const fracSuffixes = fMod && !fMod.isPrefix ? 1 : 0;
  const maxPrefixSlots = 3 - fracPrefixes;
  const maxSuffixSlots = 3 - fracSuffixes;

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

  const initialMask = (1 << targetGroupDefs.length) - 1;
  const memo = new Map();
  let totalProbability = 0;

  for (const { count, prob } of MOD_COUNT_DIST) {
    // Both fractured and essence mods take 1 of the N total slots — the remaining
    // N-1 slots are random draws. The essence group is already removed from the pool
    // so it cannot roll randomly; its slot is guaranteed to be Intelligence (or similar).
    const randomSlots = count - prePlaced.length;
    if (randomSlots < remainingTargetMods.length) continue;

    const hitProb = recursiveProb(
      initialMask,
      maxPrefixSlots,
      maxSuffixSlots,
      randomSlots,
      ntPrefixWeights,
      ntSuffixWeights,
      targetGroupDefs,
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
