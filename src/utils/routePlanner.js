import { calculateSpamEV, calculateHarvestEV } from "./calculator";
import essencesData from "../data/essences.json";
import fossilsData from "../data/fossils.json";
import harvestData from "../data/harvest.json";
import itemsData from "../data/items.json";

/**
 * Generate all viable crafting routes for a given item class + target mods,
 * sorted by expected cost (cheapest first).
 */
export function generateCraftingRoutes({
  itemClass,
  targetIds,
  influence = null,
  fracturedModId = "none",
  armourBaseTag = null,
  itemLevel = null,
}) {
  if (!targetIds || targetIds.length === 0) return [];

  const routes = [];

  function makeRoute(label, method, extraFields, result) {
    if (result.error) return null;
    return {
      label,
      method,
      probability: result.probability,
      averageTries: result.averageTries,
      expectedCostChaos: result.expectedCostChaos,
      ...extraFields,
    };
  }

  const pool = itemsData[itemClass];
  const allMods = pool ? [...pool.prefixes, ...pool.suffixes] : [];

  // ---- 1. Chaos spam (baseline, 1c/try) ----
  const chaosResult = calculateSpamEV(targetIds, null, itemClass, fracturedModId, [], influence, armourBaseTag, itemLevel);
  const chaosRoute = makeRoute("Chaos Spam", "chaos_spam", { notes: "~1c/try, no guarantee" }, chaosResult);
  if (chaosRoute) routes.push(chaosRoute);

  // ---- 2. Essence routes ----
  for (const [essenceId, essence] of Object.entries(essencesData)) {
    const guaranteedGroup = essence.guaranteed_mod_groups?.[itemClass];
    if (!guaranteedGroup) continue;

    const isTargetGroup = targetIds.some((tid) => {
      const mod = allMods.find((m) => m.id === tid);
      return mod && mod.group === guaranteedGroup;
    });

    const result = calculateSpamEV(targetIds, essenceId, itemClass, fracturedModId, [], influence, armourBaseTag, itemLevel);
    const route = makeRoute(
      essence.name,
      "essence",
      {
        essenceId,
        guaranteesTarget: isTargetGroup,
        notes: isTargetGroup
          ? `Guarantees ${guaranteedGroup}`
          : `Guaranteed: ${guaranteedGroup} (not a target)`,
      },
      result,
    );
    if (route) routes.push(route);
  }

  // ---- 3. Fossil routes (single + beneficial pairs) ----
  const fossilIds = Object.keys(fossilsData);
  const singleFossilCosts = new Map();

  for (const fossilId of fossilIds) {
    const result = calculateSpamEV(targetIds, null, itemClass, fracturedModId, [fossilId], influence, armourBaseTag, itemLevel);
    if (result.error) continue;
    singleFossilCosts.set(fossilId, result.expectedCostChaos);
    const route = makeRoute(
      fossilsData[fossilId].name,
      "fossil",
      { fossils: [fossilId], notes: fossilsData[fossilId].name },
      result,
    );
    if (route) routes.push(route);
  }

  // 2-fossil pairs — only include if cheaper than either solo
  for (let i = 0; i < fossilIds.length; i++) {
    for (let j = i + 1; j < fossilIds.length; j++) {
      const pair = [fossilIds[i], fossilIds[j]];
      const result = calculateSpamEV(targetIds, null, itemClass, fracturedModId, pair, influence, armourBaseTag, itemLevel);
      if (result.error) continue;
      const soloMin = Math.min(
        singleFossilCosts.get(fossilIds[i]) ?? Infinity,
        singleFossilCosts.get(fossilIds[j]) ?? Infinity,
      );
      if (result.expectedCostChaos >= soloMin) continue;
      const label = `${fossilsData[fossilIds[i]].name} + ${fossilsData[fossilIds[j]].name}`;
      const route = makeRoute(label, "fossil", { fossils: pair, notes: label }, result);
      if (route) routes.push(route);
    }
  }

  // ---- 4. Harvest reforge routes ----
  for (const [, craft] of Object.entries(harvestData)) {
    // Only show if at least one target mod has the guaranteed tag
    const hasRelevantTarget = targetIds.some((tid) => {
      const mod = allMods.find((m) => m.id === tid);
      return mod?.mod_tags?.includes(craft.guaranteed_tag);
    });
    if (!hasRelevantTarget) continue;

    const result = calculateHarvestEV({
      targetIds,
      guaranteedTag: craft.guaranteed_tag,
      itemTag: itemClass,
      fracturedModId,
      influence,
      costPerTry: craft.cost_chaos,
      armourBaseTag,
      itemLevel,
    });
    if (result.error) continue;
    const route = makeRoute(craft.name, "harvest", { notes: `≥1 ${craft.guaranteed_tag} mod guaranteed` }, result);
    if (route) routes.push(route);
  }

  // Sort by expected cost (cheapest first)
  routes.sort((a, b) => a.expectedCostChaos - b.expectedCostChaos);

  return routes;
}
