import ringsData from '../data/rings.json';
import mockData from '../data/active_economy.json';

const SIMULATION_ITERATIONS = 500000;

export function calculateSpamEV(target1Id, target2Id, essenceId = 'deafening_essence_of_spite', itemTag = 'ring', fracturedModId = 'none') {
  const essence = mockData.essences[essenceId];
  if (!essence) return { error: "Invalid essence." };
  
  const essenceCost = essence.cost;
  const guaranteedModId = essence.guaranteed_mod;

  if (target1Id === 'any' && target2Id === 'any') {
    return {
      probability: "100.0000%",
      averageTries: 1,
      expectedCostChaos: essenceCost
    };
  }

  const validPrefixes = ringsData.prefixes.map(m => ({
    id: m.id, group: m.group, 
    weight: m.spawn_weights.find(sw => sw.tag === itemTag)?.weight || 0,
    isPrefix: true
  })).filter(m => m.weight > 0);

  const validSuffixes = ringsData.suffixes.map(m => ({
    id: m.id, group: m.group, 
    weight: m.spawn_weights.find(sw => sw.tag === itemTag)?.weight || 0,
    isPrefix: false
  })).filter(m => m.weight > 0);

  let gMod = validPrefixes.find(m => m.id === guaranteedModId) || validSuffixes.find(m => m.id === guaranteedModId);
  if (!gMod) return { error: "Guaranteed mod not found." };

  // Locate the fractured mod data if one is selected
  let fMod = null;
  if (fracturedModId !== 'none') {
    fMod = validPrefixes.find(m => m.id === fracturedModId) || validSuffixes.find(m => m.id === fracturedModId);
    if (!fMod) return { error: "Fractured mod not found." };
    if (fMod.group === gMod.group) return { error: "Essence and Fracture cannot belong to the same mod group." };
  }

  let successes = 0;

  // --- THE MONTE CARLO LOOP ---
  for (let i = 0; i < SIMULATION_ITERATIONS; i++) {
    let currentPrefixes = 0;
    let currentSuffixes = 0;
    let rolledGroups = new Set();
    let rolledIds = new Set();

    // 1. Inject the Essence Mod
    rolledIds.add(gMod.id);
    rolledGroups.add(gMod.group);
    if (gMod.isPrefix) currentPrefixes++; else currentSuffixes++;

    // 2. Inject the Fractured Mod (if it exists)
    if (fMod) {
      rolledIds.add(fMod.id);
      rolledGroups.add(fMod.group);
      if (fMod.isPrefix) currentPrefixes++; else currentSuffixes++;
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
          const isJunk = p.id.startsWith('junk_');
          if (isJunk || !rolledGroups.has(p.group)) { 
            combinedPool.push(p); 
            totalWeight += p.weight; 
          }
        }
      }

      if (currentSuffixes < 3) {
        for (let s of validSuffixes) {
          const isJunk = s.id.startsWith('junk_');
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
        const isJunk = selected.id.startsWith('junk_');
        
        if (!isJunk) {
          rolledGroups.add(selected.group);
        }
        
        if (selected.isPrefix) currentPrefixes++; else currentSuffixes++;
      }
    }

    const hitTarget1 = target1Id === 'any' || rolledIds.has(target1Id);
    const hitTarget2 = target2Id === 'any' || rolledIds.has(target2Id);

    if (hitTarget1 && hitTarget2) {
      successes++;
    }
  }

  const hitRate = successes / SIMULATION_ITERATIONS;
  
  if (hitRate === 0) return { error: "Too rare to simulate (> 500,000 tries), or impossible combo." };

  const expectedTries = Math.round(1 / hitRate);
  const expectedCostChaos = expectedTries * essenceCost;

  return {
    probability: (hitRate * 100).toFixed(4) + "%",
    averageTries: expectedTries,
    expectedCostChaos: expectedCostChaos
  };
}