import ringsData from "../data/rings.json";
import mockData from "../data/active_economy.json";
import fossilData from "../data/fossils.json";

const SIMULATION_ITERATIONS = 500000;

// The mathematical rules for Fossils
const FOSSIL_DATA = {
  pristine: {
    multipliers: {
      life: 10,
      defences: 0,
      armour: 0,
      evasion: 0,
      energy_shield: 0,
    },
  },
  aberrant: { multipliers: { chaos: 10, lightning: 0 } },
  metallic: { multipliers: { lightning: 10, physical: 0 } },
  prismatic: {
    multipliers: { fire: 10, cold: 10, lightning: 10, poison: 0, bleeding: 0 },
  },
};

// The Weight Adjustment Phase
function applyFossilMultipliers(pool, activeFossilIds) {
  if (!activeFossilIds || activeFossilIds.length === 0) return pool;

  return pool
    .map((mod) => {
      let finalWeight = mod.weight;

      activeFossilIds.forEach((fossilId) => {
        // READ FROM THE IMPORTED JSON HERE
        const fossil = fossilData[fossilId];
        if (!fossil) return;

        let highestMultiplier = 1;
        let hasZeroMultiplier = false;

        mod.mod_tags.forEach((tag) => {
          if (fossil.multipliers[tag] !== undefined) {
            const mult = fossil.multipliers[tag];
            if (mult === 0) {
              hasZeroMultiplier = true;
            } else if (mult > highestMultiplier) {
              highestMultiplier = mult;
            }
          }
        });

        if (hasZeroMultiplier) {
          finalWeight = 0;
        } else {
          finalWeight *= highestMultiplier;
        }
      });

      return { ...mod, weight: finalWeight };
    })
    .filter((mod) => mod.weight > 0);
}

export function calculateSpamEV(
  targetIds = [],
  essenceId = "deafening_essence_of_spite",
  itemTag = "ring",
  fracturedModId = "none",
  activeFossils = [],
) {
  // For the MVP Fossil test, we are assuming a 1 Chaos cost per try if using fossils
  const costPerTry =
    activeFossils.length > 0 ? 1 : mockData.essences[essenceId]?.cost || 1;
  const guaranteedModId =
    activeFossils.length > 0
      ? null
      : mockData.essences[essenceId]?.guaranteed_mod;

  if (targetIds.length === 0) {
    return {
      probability: "100.0000%",
      averageTries: 1,
      expectedCostChaos: costPerTry,
    };
  }

  // 1. Load Raw Weights & Tags
  let validPrefixes = ringsData.prefixes
    .map((m) => ({
      id: m.id,
      group: m.group,
      weight: m.spawn_weights.find((sw) => sw.tag === itemTag)?.weight || 0,
      isPrefix: true,
      mod_tags: m.mod_tags || [],
    }))
    .filter((m) => m.weight > 0);

  let validSuffixes = ringsData.suffixes
    .map((m) => ({
      id: m.id,
      group: m.group,
      weight: m.spawn_weights.find((sw) => sw.tag === itemTag)?.weight || 0,
      isPrefix: false,
      mod_tags: m.mod_tags || [],
    }))
    .filter((m) => m.weight > 0);

  // 2. Apply Dynamic Multipliers (The new phase)
  validPrefixes = applyFossilMultipliers(validPrefixes, activeFossils);
  validSuffixes = applyFossilMultipliers(validSuffixes, activeFossils);

  // 3. Handle Hard States (Essences & Fractures)
  let gMod = null;
  if (guaranteedModId) {
    gMod =
      validPrefixes.find((m) => m.id === guaranteedModId) ||
      validSuffixes.find((m) => m.id === guaranteedModId);
    if (!gMod) return { error: "Guaranteed mod not found." };
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

  let successes = 0;

  // --- THE MONTE CARLO LOOP ---
  for (let i = 0; i < SIMULATION_ITERATIONS; i++) {
    let currentPrefixes = 0;
    let currentSuffixes = 0;
    let rolledGroups = new Set();
    let rolledIds = new Set();

    if (gMod) {
      rolledIds.add(gMod.id);
      rolledGroups.add(gMod.group);
      if (gMod.isPrefix) currentPrefixes++;
      else currentSuffixes++;
    }

    if (fMod) {
      rolledIds.add(fMod.id);
      rolledGroups.add(fMod.group);
      if (fMod.isPrefix) currentPrefixes++;
      else currentSuffixes++;
    }

    let targetModCount = 4;
    const rng = Math.random();
    if (rng > 0.9166) targetModCount = 6;
    else if (rng > 0.6666) targetModCount = 5;

    while (currentPrefixes + currentSuffixes < targetModCount) {
      let combinedPool = [];
      let totalWeight = 0;

      if (currentPrefixes < 3) {
        for (let p of validPrefixes) {
          const isJunk = p.id.startsWith("junk_");
          if (isJunk || !rolledGroups.has(p.group)) {
            combinedPool.push(p);
            totalWeight += p.weight;
          }
        }
      }

      if (currentSuffixes < 3) {
        for (let s of validSuffixes) {
          const isJunk = s.id.startsWith("junk_");
          if (isJunk || !rolledGroups.has(s.group)) {
            combinedPool.push(s);
            totalWeight += s.weight;
          }
        }
      }

      if (totalWeight === 0) break;

      let roll = Math.random() * totalWeight;
      let runningSum = 0;
      let selected = null;

      for (let mod of combinedPool) {
        runningSum += mod.weight;
        if (roll <= runningSum) {
          selected = mod;
          break;
        }
      }

      if (selected) {
        rolledIds.add(selected.id);
        if (!selected.id.startsWith("junk_")) rolledGroups.add(selected.group);
        if (selected.isPrefix) currentPrefixes++;
        else currentSuffixes++;
      }
    }

    let hitAll = true;
    for (let tId of targetIds) {
      const tMatch = tId.match(/(.+)_tier_(\d+)/);
      const tBase = tMatch ? tMatch[1] : tId;
      const tTier = tMatch ? parseInt(tMatch[2], 10) : 0;

      let foundMatch = false;

      for (let rId of rolledIds) {
        if (rId === tId) {
          foundMatch = true;
          break;
        }

        const rMatch = rId.match(/(.+)_tier_(\d+)/);
        if (tMatch && rMatch) {
          const rBase = rMatch[1];
          const rTier = parseInt(rMatch[2], 10);

          if (rBase === tBase && rTier <= tTier) {
            foundMatch = true;
            break;
          }
        }
      }

      if (!foundMatch) {
        hitAll = false;
        break;
      }
    }

    if (hitAll) successes++;
  }

  const hitRate = successes / SIMULATION_ITERATIONS;
  if (hitRate === 0)
    return {
      error: "Too rare to simulate (> 500,000 tries), or impossible combo.",
    };

  const expectedTries = Math.round(1 / hitRate);
  const expectedCostChaos = expectedTries * costPerTry;

  return {
    probability: (hitRate * 100).toFixed(4) + "%",
    averageTries: expectedTries,
    expectedCostChaos: expectedCostChaos,
  };
}
