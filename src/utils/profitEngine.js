import { generateCraftingRoutes } from "./routePlanner";
import itemsData from "../data/items.json";
import economyData from "../data/active_economy.json";

/**
 * Resolve a (group, tierFloor, influence, itemClass) tuple to the best mod ID
 * in items.json for craft EV calculation.
 *
 * We do NOT filter by spawn weight here — if T1 is essence-only (zero weight),
 * we still return its ID. routePlanner's remappedTargetIds already remaps
 * zero-weight mods to the best rollable tier in the same group, so passing the
 * essence-only ID is safe and lets routePlanner model the correct craft paths.
 *
 * Returns null only when the group has no mods at all for this item class.
 */
function resolveModId(group, tierFloor, influence, itemClass) {
  const pool = itemsData[itemClass];
  if (!pool) return null;

  const allMods = [...pool.prefixes, ...pool.suffixes];

  // Include any mod in the group within the tier constraint, regardless of weight.
  const candidates = allMods.filter((m) => {
    if (m.group !== group) return false;
    if (m.tier != null && m.tier > tierFloor) return false;
    if (m.influence && influence && m.influence !== influence) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Sort: rollable mods first; among ties, highest tier number (cheapest craft).
  const isRollable = (m) =>
    (m.spawn_weights || []).some((sw) => sw.weight > 0) ||
    Object.values(m.base_weights || {}).some((w) => w > 0);

  candidates.sort((a, b) => {
    const ra = isRollable(a);
    const rb = isRollable(b);
    if (ra !== rb) return rb ? 1 : -1;       // rollable first
    return (b.tier ?? 0) - (a.tier ?? 0);    // then highest tier = cheapest
  });

  return candidates[0].id;
}

/**
 * For a single target entry from trade_prices.json, compute full profit data.
 *
 * Returns one of:
 *   { uncomputable: true, reason, sellPrice? }
 *   { uncomputable: false, sellPrice, bestCraftCost, profit, profitDiv,
 *     roi, bestRoute, routes, influence }
 */
export function computeTargetProfit(target) {
  if (!target.price_data) {
    return { uncomputable: true, reason: "no_price_data" };
  }

  const { slot, required_mods, price_data } = target;
  const sellPrice = price_data.median;

  // Detect influence situation across all required mods
  const infSet = new Set(
    required_mods.filter((m) => m.influence).map((m) => m.influence)
  );

  if (infSet.size > 1) {
    // Dual-influence items (e.g. Crusader + Warlord) require Awakener's Orb —
    // outside our current EV model.
    return { sellPrice, uncomputable: true, reason: "multi_influence" };
  }

  const influence = infSet.size === 1 ? [...infSet][0] : null;

  // Resolve each required mod group → a concrete mod ID in items.json
  const resolved = required_mods.map((m) => ({
    group: m.group,
    id: resolveModId(m.group, m.tier_floor, m.influence ?? influence, slot),
  }));
  const targetIds = resolved.filter((r) => r.id !== null).map((r) => r.id);
  const unresolvedGroups = resolved.filter((r) => r.id === null).map((r) => r.group);

  if (targetIds.length === 0) {
    return { sellPrice, uncomputable: true, reason: "no_mods_resolved" };
  }

  // Fractured base handling: when the build's sampled items typically use a
  // fractured base (e.g. fractured Life on Chieftain RF body armour), we want
  // routePlanner to model the craft starting from that base — the fractured
  // mod is pre-locked and excluded from rolling EV.
  const fracturedGroup = target.fractured_group ?? null;
  const fracturedModId = fracturedGroup
    ? resolveModId(fracturedGroup, 1, influence, slot)
    : null;

  const routes = generateCraftingRoutes({
    itemClass: slot,
    targetIds,
    influence,
    fracturedModId: fracturedModId ?? "none",
    armourBaseTag: null,
    itemLevel: 86,
  });

  if (!routes || routes.length === 0) {
    return { sellPrice, uncomputable: true, reason: "no_routes" };
  }

  const bestRoute = routes[0];
  const rollCost = bestRoute.expectedCostChaos;

  // Base item cost: the price of the raw unidentified blank (e.g. Manifold Ring iLvl 85+).
  // Stored in trade_prices.json as base_cost_chaos after running fetch_trade_prices.py.
  // Falls back to 0 when not yet populated so existing data still renders.
  const baseCost = target.base_cost_chaos ?? 0;
  const bestCraftCost = rollCost + baseCost;
  const profit = sellPrice - bestCraftCost;
  const divinePrice = economyData.divine_price || 150;

  return {
    uncomputable: false,
    sellPrice,
    rollCost,
    baseCost,
    bestCraftCost,         // rollCost + baseCost
    profit,
    unresolvedGroups,
    profitDiv: profit / divinePrice,
    roi: bestCraftCost > 0 ? profit / bestCraftCost : 0,
    bestRoute,
    routes: routes.slice(0, 8),
    influence,
    commonBase: target.common_base ?? null,
    fracturedGroup,
    fracturedModId,
    isFracturedBase: !!(target.is_fractured_base && fracturedModId),
    fracturedFreqPct: target.fractured_freq_pct ?? 0,
  };
}

/**
 * Run computeTargetProfit over every target and return enriched cells,
 * sorted by profit descending (N/A cells last).
 */
export function computeHeatmap(tradePricesData) {
  return tradePricesData.targets
    .map((target) => ({
      target,
      profitData: computeTargetProfit(target),
    }))
    .sort((a, b) => {
      const pa = a.profitData.uncomputable ? -Infinity : a.profitData.profit;
      const pb = b.profitData.uncomputable ? -Infinity : b.profitData.profit;
      return pb - pa;
    });
}
