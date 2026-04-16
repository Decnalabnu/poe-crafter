import { useState, useEffect, useMemo } from "react";
import tradePricesData from "../data/trade_prices.json";
import itemsData from "../data/items.json";
import buildItemsData from "../data/build_items.json";
import { computeTargetProfit } from "../utils/profitEngine";
import { useEconomy } from "../contexts/EconomyContext";

const SLOT_LABELS = {
  ring: "Ring",
  amulet: "Amulet",
  belt: "Belt",
  helmet: "Helmet",
  body_armour: "Body Armour",
  gloves: "Gloves",
  boots: "Boots",
};

const SLOT_ORDER = ["ring", "amulet", "belt", "helmet", "body_armour", "gloves", "boots"];

const METHOD_COLORS = {
  chaos_spam: "#888",
  essence:    "#9b59d4",
  fossil:     "#e2b659",
  harvest:    "#4CAF50",
};
const METHOD_ICONS = {
  chaos_spam: "⚗",
  essence:    "💎",
  fossil:     "🪨",
  harvest:    "🌱",
};

const REASON_LABELS = {
  no_price_data:    "No market data",
  multi_influence:  "Dual-influence (Awakener's Orb)",
  no_mods_resolved: "Mods not in item pool",
  no_routes:        "No viable craft routes",
};

// Threshold below which we show a sparse-listing warning
const SPARSE_LISTING_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function profitColor(profit) {
  if (profit > 1000)  return "#4CAF50";
  if (profit > 200)   return "#2d8c2d";
  if (profit > 20)    return "#1a5a1a";
  if (profit >= -20)  return "#333";
  if (profit >= -200) return "#4a1414";
  return "#6e1010";
}

function profitTextColor(profit) {
  if (profit > 200)   return "#4CAF50";
  if (profit > 20)    return "#7ec87e";
  if (profit >= -20)  return "#777";
  if (profit >= -200) return "#e27b7b";
  return "#ff6666";
}

function formatChaos(c, divinePrice) {
  const d = divinePrice || 150;
  if (Math.abs(c) >= d) {
    return `${(c / d).toFixed(1)}d`;
  }
  return `${Math.round(c)}c`;
}

const INFLUENCE_COLORS = {
  shaper:   "#7bafdd",
  elder:    "#c77be3",
  crusader: "#e2c060",
  hunter:   "#7ec87e",
  redeemer: "#63c7b8",
  warlord:  "#e27b7b",
};

// ---------------------------------------------------------------------------
// Example item helpers
// ---------------------------------------------------------------------------

function formatModText(rawText) {
  if (!rawText) return "";
  let t = rawText.replace(/\s*\[[^\]]+\]$/, "").trim();
  t = t.replace(/\((\d+)\s*[—–]\s*(\d+)\)/g, "($1-$2)");
  if (/^\(\d+-\d+\)\s/.test(t)) t = "+" + t;
  return t;
}

function resolveDisplayMod(reqMod, itemClass) {
  const pool = itemsData[itemClass];
  if (!pool) return null;

  const allMods = [
    ...pool.prefixes.map((m) => ({ ...m, isPrefix: true })),
    ...pool.suffixes.map((m) => ({ ...m, isPrefix: false })),
  ];

  const reqInf = reqMod.influence ?? null;

  const candidates = allMods.filter((m) => {
    if (m.group !== reqMod.group) return false;
    if (m.tier != null && m.tier > reqMod.tier_floor) return false;
    if (reqInf && m.influence && m.influence !== reqInf) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
  const best = candidates[0];

  return {
    text: formatModText(best.text),
    isPrefix: best.isPrefix,
    influence: reqInf ?? best.influence ?? null,
    tier: best.tier,
  };
}

const FRACTURED_COLOR  = "#a29162";
const FRACTURED_BORDER = "#5a4a20";

function ExampleItemCard({ target, commonBase }) {
  const { slot, required_mods, influence } = target;
  const slotLabel = SLOT_LABELS[slot] ?? slot;
  const isFractured = !!target.is_fractured_base;
  const fracturedGroup = target.fractured_group ?? null;

  const mods = required_mods
    .map((rm) => ({ ...resolveDisplayMod(rm, slot), group: rm.group }))
    .filter((m) => m && m.text);

  if (fracturedGroup && !mods.some((m) => m.group === fracturedGroup)) {
    const synthetic = resolveDisplayMod(
      { group: fracturedGroup, tier_floor: 1, influence: null },
      slot,
    );
    if (synthetic) mods.push({ ...synthetic, group: fracturedGroup });
  }

  const prefixes = mods.filter((m) => m.isPrefix);
  const suffixes = mods.filter((m) => !m.isPrefix);

  const influenceColor = influence ? (INFLUENCE_COLORS[influence] ?? "#aaa") : null;
  const borderColor = isFractured ? FRACTURED_BORDER : (influenceColor ?? "#8b6914");

  function renderMod(m, i) {
    const isFracturedMod = isFractured && fracturedGroup && m.group === fracturedGroup;
    const color = isFracturedMod
      ? FRACTURED_COLOR
      : (m.influence ? (INFLUENCE_COLORS[m.influence] ?? "#c8a84a") : "#8bb8e8");
    return (
      <div key={i} style={{
        color, marginBottom: "3px", lineHeight: "1.4",
        display: "flex", alignItems: "center", gap: "6px",
        textShadow: isFracturedMod ? "0 0 6px rgba(162, 145, 98, 0.3)" : "none",
      }}>
        <span>{m.text}</span>
        {isFracturedMod && (
          <span style={{
            color: "#000", background: FRACTURED_COLOR, fontSize: "9px",
            letterSpacing: "0.08em", padding: "1px 5px", borderRadius: "2px",
            fontWeight: "bold", fontFamily: "sans-serif",
          }}>
            FRACTURED
          </span>
        )}
        <span style={{ color: "#4a3a20", fontSize: "10px", marginLeft: "auto" }}>T{m.tier}</span>
      </div>
    );
  }

  return (
    <div style={{
      background: "#12100a", border: `2px solid ${borderColor}`,
      borderRadius: "4px", fontSize: "13px",
      fontFamily: "Georgia, 'Times New Roman', serif",
      marginBottom: "14px", overflow: "hidden",
    }}>
      <div style={{
        background: "linear-gradient(to bottom, #2a2000, #1a1400)",
        padding: "10px 14px", textAlign: "center",
        borderBottom: `1px solid ${isFractured ? FRACTURED_BORDER : (influenceColor ?? "#5a4010")}`,
      }}>
        <div style={{ color: "#c8a84a", fontWeight: "bold", fontSize: "15px", letterSpacing: "0.03em" }}>
          Crafting Target
        </div>
        <div style={{ color: "#a09080", fontSize: "12px", marginTop: "2px" }}>
          {commonBase ? `${commonBase} (${slotLabel})` : slotLabel}
          {influence && (
            <span style={{ marginLeft: "8px", color: influenceColor, fontSize: "11px" }}>
              [{influence}]
            </span>
          )}
          {isFractured && (
            <span style={{ marginLeft: "8px", color: FRACTURED_COLOR, fontSize: "11px", fontWeight: "bold" }}>
              [fractured base]
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: "8px 14px 10px" }}>
        {prefixes.length > 0 && (
          <>
            <div style={{ color: "#4a3a20", fontSize: "10px", letterSpacing: "0.08em", marginBottom: "4px", marginTop: "2px" }}>
              PREFIXES
            </div>
            {prefixes.map(renderMod)}
          </>
        )}
        {suffixes.length > 0 && (
          <>
            <div style={{ color: "#4a3a20", fontSize: "10px", letterSpacing: "0.08em", marginBottom: "4px", marginTop: prefixes.length ? "8px" : "2px" }}>
              SUFFIXES
            </div>
            {suffixes.map(renderMod)}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile link helpers
// ---------------------------------------------------------------------------

function poENinjaUrl(build, league) {
  const parts = build.split(" / ");
  const charClass = encodeURIComponent(parts[0] ?? "");
  const skill     = encodeURIComponent(parts[1] ?? "");
  const leagueSeg = (league ?? "").toLowerCase().replace(/\s+/g, "-");
  return `https://poe.ninja/builds/${leagueSeg}?class=${charClass}&skill=${skill}`;
}

function getExampleChars(buildStr) {
  const parts = buildStr.split(" / ");
  const build = buildItemsData.builds?.find(
    (b) => b.char_class === parts[0] && b.primary_skill === parts[1]
  );
  return build?.example_chars ?? null;
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function RouteRow({ route, sellPrice, baseCost, divinePrice }) {
  const totalCost = route.expectedCostChaos + (baseCost ?? 0);
  const profit = sellPrice - totalCost;
  const color = profit >= 0 ? "#4CAF50" : "#ff6666";
  const icon = METHOD_ICONS[route.method] ?? "?";
  const methodColor = METHOD_COLORS[route.method] ?? "#aaa";

  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "8px 12px", marginBottom: "4px",
      background: "#1a1a1a", border: "1px solid #333", borderRadius: "4px",
      fontSize: "13px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "14px" }}>{icon}</span>
        <div>
          <div style={{ color: methodColor, fontWeight: "bold" }}>{route.label}</div>
          <div style={{ color: "#555", fontSize: "11px" }}>{route.notes}</div>
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ color: "#e2b659" }}>
          {formatChaos(route.expectedCostChaos, divinePrice)} rolling
        </div>
        <div style={{ color }}>
          {profit >= 0 ? "+" : ""}{formatChaos(profit, divinePrice)} profit
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ cell, onClose }) {
  const { divine_price } = useEconomy();
  const divinePrice = divine_price || 150;
  const { target, profitData } = cell;
  const league = tradePricesData.league;

  const ninjaUrl = poENinjaUrl(target.build, league);
  const exampleChars = getExampleChars(target.build);
  const isSparse = target.price_data && target.price_data.total_listings < SPARSE_LISTING_THRESHOLD;

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: "420px",
      background: "#111", borderLeft: "1px solid #333",
      overflowY: "auto", zIndex: 100, padding: "20px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
        <div>
          <div style={{ color: "#c77be3", fontWeight: "bold", fontSize: "15px" }}>
            {target.build}
          </div>
          <div style={{ color: "#aaa", fontSize: "13px", marginTop: "2px" }}>
            {SLOT_LABELS[target.slot] ?? target.slot}
            {profitData.influence && (
              <span style={{ marginLeft: "8px", color: "#e2c060", fontSize: "11px", border: "1px solid #e2c060", borderRadius: "3px", padding: "1px 5px" }}>
                {profitData.influence.toUpperCase()}
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", fontSize: "20px", cursor: "pointer", padding: "0 4px" }}>×</button>
      </div>

      {/* Sparse listing warning */}
      {isSparse && (
        <div style={{
          padding: "8px 12px", background: "#1a1400", border: "1px solid #5a4000",
          borderRadius: "4px", fontSize: "12px", color: "#c08000", marginBottom: "12px",
          display: "flex", alignItems: "center", gap: "8px",
        }}>
          <span style={{ fontSize: "14px" }}>⚠</span>
          <span>
            Only <strong>{target.price_data.total_listings}</strong> listings — price may not reflect true market depth.
          </span>
        </div>
      )}

      <div style={{ color: "#555", fontSize: "11px", letterSpacing: "0.06em", marginBottom: "6px" }}>EXAMPLE TARGET ITEM</div>
      <ExampleItemCard target={target} commonBase={profitData.commonBase} />

      {/* Profile links */}
      <div style={{ marginBottom: "16px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <a
          href={ninjaUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex", alignItems: "center", gap: "8px",
            padding: "8px 12px", background: "#1a1a2a",
            border: "1px solid #3a3a6a", borderRadius: "4px",
            color: "#7bafdd", fontSize: "12px", textDecoration: "none",
          }}
        >
          <span style={{ fontSize: "14px" }}>🔗</span>
          <div>
            <div style={{ fontWeight: "bold" }}>Browse on poe.ninja</div>
            <div style={{ color: "#555", fontSize: "11px" }}>
              Real {target.build.split(" / ")[0]} profiles using this slot
            </div>
          </div>
        </a>

        {exampleChars && exampleChars.length > 0 && (
          <div style={{ marginTop: "4px" }}>
            <div style={{ color: "#555", fontSize: "11px", letterSpacing: "0.06em", marginBottom: "4px" }}>
              EXAMPLE CHARACTERS (from ladder scan)
            </div>
            {exampleChars.map(({ account, char }, i) => (
              <a
                key={i}
                href={`https://www.pathofexile.com/account/view-profile/${encodeURIComponent(account)}/characters`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex", alignItems: "center", gap: "8px",
                  padding: "6px 10px", marginBottom: "3px",
                  background: "#151515", border: "1px solid #2a2a2a",
                  borderRadius: "4px", color: "#aaa", fontSize: "12px",
                  textDecoration: "none",
                }}
              >
                <span style={{ color: "#4CAF50", fontSize: "11px" }}>↗</span>
                <div>
                  <span style={{ color: "#ddd" }}>{char}</span>
                  <span style={{ color: "#444", marginLeft: "6px" }}>{account}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {profitData.uncomputable ? (
        <div style={{
          padding: "14px", background: "#1a1020", border: "1px solid #44204a",
          borderRadius: "6px", color: "#a07ab0", fontSize: "13px",
        }}>
          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>Cannot compute craft EV</div>
          <div style={{ color: "#777" }}>{REASON_LABELS[profitData.reason] ?? profitData.reason}</div>
        </div>
      ) : (
        <>
          {/* Market summary */}
          <div style={{
            padding: "12px 14px", background: "#0f1a0f", border: "1px solid #2a4a2a",
            borderRadius: "6px", marginBottom: "14px",
          }}>
            <div style={{ color: "#4CAF50", fontSize: "11px", fontWeight: "bold", letterSpacing: "0.06em", marginBottom: "8px" }}>
              MARKET PRICE
            </div>
            <div style={{ display: "flex", gap: "16px" }}>
              {[["p10", "Floor"], ["median", "Median"], ["p90", "Ceiling"]].map(([key, label]) => (
                <div key={key} style={{ textAlign: "center" }}>
                  <div style={{ color: "#555", fontSize: "11px" }}>{label}</div>
                  <div style={{
                    color: key === "median" ? "#e2b659" : "#ccc",
                    fontWeight: key === "median" ? "bold" : "normal",
                    fontSize: key === "median" ? "16px" : "13px",
                  }}>
                    {formatChaos(target.price_data[key], divinePrice)}
                  </div>
                </div>
              ))}
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#555", fontSize: "11px" }}>Listings</div>
                <div style={{ color: isSparse ? "#c08000" : "#ccc", fontSize: "13px" }}>
                  {target.price_data.total_listings}
                  {isSparse && <span style={{ marginLeft: "4px" }}>⚠</span>}
                </div>
              </div>
            </div>
          </div>

          {/* Cost breakdown + profit summary */}
          <div style={{
            padding: "12px 14px",
            background: profitData.profit >= 0 ? "#0d200d" : "#200d0d",
            border: `1px solid ${profitData.profit >= 0 ? "#2a5a2a" : "#5a2a2a"}`,
            borderRadius: "6px", marginBottom: "16px",
          }}>
            <div style={{ marginBottom: "10px" }}>
              <div style={{ color: "#555", fontSize: "11px", letterSpacing: "0.05em", marginBottom: "6px" }}>
                COST BREAKDOWN
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "3px" }}>
                <span style={{ color: "#888" }}>Rolling ({profitData.bestRoute.label})</span>
                <span style={{ color: "#e2b659" }}>{formatChaos(profitData.rollCost, divinePrice)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "3px" }}>
                <span style={{ color: profitData.baseCost === 0 ? "#444" : "#888" }}>
                  {profitData.isFracturedBase ? (
                    <span style={{ color: FRACTURED_COLOR, fontWeight: "bold" }}>Fractured base</span>
                  ) : "Base item"}
                  {profitData.commonBase && (
                    <span style={{ color: "#555", fontStyle: "italic", marginLeft: "6px" }}>({profitData.commonBase})</span>
                  )}
                  {profitData.isFracturedBase && profitData.fracturedGroup && (
                    <span style={{ color: FRACTURED_COLOR, fontSize: "10px", marginLeft: "6px" }}>
                      · {profitData.fracturedGroup} locked ({profitData.fracturedFreqPct?.toFixed?.(0) ?? "?"}% of ladder)
                    </span>
                  )}
                  {profitData.baseCost === 0 && (
                    <span style={{ color: "#444", marginLeft: "6px", fontSize: "10px" }}>
                      — run fetch_trade_prices.py to populate
                    </span>
                  )}
                </span>
                <span style={{ color: profitData.baseCost === 0 ? "#444" : "#e2b659" }}>
                  {profitData.baseCost === 0 ? "unknown" : formatChaos(profitData.baseCost, divinePrice)}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", borderTop: "1px solid #2a3a2a", paddingTop: "4px", marginTop: "4px" }}>
                <span style={{ color: "#aaa" }}>Total cost</span>
                <span style={{ color: "#e2b659", fontWeight: "bold" }}>
                  {formatChaos(profitData.bestCraftCost, divinePrice)}
                  {profitData.baseCost === 0 && <span style={{ color: "#444", fontSize: "10px" }}> + base</span>}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #2a3a2a", paddingTop: "8px" }}>
              <div>
                <div style={{ color: "#777", fontSize: "11px" }}>
                  Sell: {formatChaos(profitData.sellPrice, divinePrice)}
                </div>
                <div style={{ color: "#555", fontSize: "11px" }}>
                  ROI {profitData.roi >= 0 ? "+" : ""}{(profitData.roi * 100).toFixed(0)}%
                  {profitData.baseCost === 0 && " (excl. base)"}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#555", fontSize: "11px" }}>Expected profit</div>
                <div style={{ color: profitData.profit >= 0 ? "#4CAF50" : "#ff6666", fontWeight: "bold", fontSize: "18px" }}>
                  {profitData.profit >= 0 ? "+" : ""}{formatChaos(profitData.profit, divinePrice)}
                  {profitData.baseCost === 0 && <span style={{ color: "#444", fontSize: "11px" }}> – base</span>}
                </div>
              </div>
            </div>
          </div>

          {profitData.unresolvedGroups?.length > 0 && (
            <div style={{
              padding: "8px 12px", background: "#1a1400", border: "1px solid #4a3a00",
              borderRadius: "4px", fontSize: "12px", color: "#a08020", marginBottom: "12px",
            }}>
              <strong>Note:</strong> {profitData.unresolvedGroups.length} mod(s) excluded from craft EV
              (not in item pool — craft cost may be understated):
              <div style={{ color: "#6a5010", marginTop: "3px" }}>
                {profitData.unresolvedGroups.join(", ")}
              </div>
            </div>
          )}

          <div style={{ color: "#555", fontSize: "11px", letterSpacing: "0.06em", marginBottom: "8px" }}>
            CRAFT ROUTES (cheapest first)
          </div>
          {profitData.routes.map((route, i) => (
            <RouteRow key={i} route={route} sellPrice={profitData.sellPrice} baseCost={profitData.baseCost} divinePrice={divinePrice} />
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeatmapCell
// ---------------------------------------------------------------------------

function HeatmapCell({ cell, onClick, isSelected }) {
  const { divine_price } = useEconomy();
  const divinePrice = divine_price || 150;
  const { profitData, target } = cell;
  const isSparse = target.price_data && target.price_data.total_listings < SPARSE_LISTING_THRESHOLD;

  if (profitData.pending) {
    return (
      <div style={{
        padding: "8px 6px", background: "#1a1a1a",
        border: isSelected ? "1px solid #444" : "1px solid #222",
        borderRadius: "4px", textAlign: "center", fontSize: "11px",
        color: "#333", minHeight: "48px",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        ···
      </div>
    );
  }

  if (profitData.uncomputable) {
    const bg = profitData.reason === "no_price_data" ? "#1a1a1a" : "#1e1430";
    return (
      <div
        onClick={() => profitData.reason !== "no_price_data" && onClick(cell)}
        style={{
          padding: "8px 6px", background: bg,
          border: isSelected ? "1px solid #6040a0" : "1px solid #2a2a2a",
          borderRadius: "4px", textAlign: "center", fontSize: "11px",
          color: profitData.reason === "no_price_data" ? "#2a2a2a" : "#5a4a70",
          cursor: profitData.reason !== "no_price_data" ? "pointer" : "default",
          minHeight: "48px", display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {profitData.reason === "no_price_data" ? "—" : "N/A"}
      </div>
    );
  }

  const { profit, bestRoute } = profitData;
  const icon = METHOD_ICONS[bestRoute.method] ?? "?";
  const methodColor = METHOD_COLORS[bestRoute.method] ?? "#888";

  return (
    <div
      onClick={() => onClick(cell)}
      style={{
        padding: "8px 6px", background: profitColor(profit),
        border: isSelected ? "2px solid #fff" : "1px solid #333",
        borderRadius: "4px", textAlign: "center",
        cursor: "pointer", minHeight: "48px",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: "2px", position: "relative",
      }}
    >
      {isSparse && (
        <span style={{ position: "absolute", top: "2px", right: "3px", fontSize: "9px", color: "#c08000" }}>⚠</span>
      )}
      <div style={{ fontSize: "10px", color: methodColor }}>{icon}</div>
      <div style={{ color: profitTextColor(profit), fontWeight: "bold", fontSize: "12px" }}>
        {profit >= 0 ? "+" : ""}{formatChaos(profit, divinePrice)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({ allSlots, allMethods, filters, onChange }) {
  const { slots, methods, minListings, sortBy } = filters;

  function toggleSlot(slot) {
    const next = slots.includes(slot) ? slots.filter(s => s !== slot) : [...slots, slot];
    onChange({ ...filters, slots: next });
  }

  function toggleMethod(method) {
    const next = methods.includes(method) ? methods.filter(m => m !== method) : [...methods, method];
    onChange({ ...filters, methods: next });
  }

  return (
    <div style={{
      background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "6px",
      padding: "12px 16px", marginBottom: "16px",
      display: "flex", flexDirection: "column", gap: "10px",
    }}>
      {/* Slot filter */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ color: "#555", fontSize: "11px", letterSpacing: "0.05em", minWidth: "48px" }}>SLOT</span>
        <button
          onClick={() => onChange({ ...filters, slots: [] })}
          style={{
            padding: "3px 10px", fontSize: "11px",
            background: slots.length === 0 ? "#3a3a3a" : "transparent",
            color: slots.length === 0 ? "#ddd" : "#555",
            border: `1px solid ${slots.length === 0 ? "#666" : "#333"}`,
            borderRadius: "3px", cursor: "pointer",
          }}
        >
          All
        </button>
        {allSlots.map((slot) => (
          <button
            key={slot}
            onClick={() => toggleSlot(slot)}
            style={{
              padding: "3px 10px", fontSize: "11px",
              background: slots.includes(slot) ? "#2a4a2a" : "transparent",
              color: slots.includes(slot) ? "#4CAF50" : "#555",
              border: `1px solid ${slots.includes(slot) ? "#4CAF50" : "#333"}`,
              borderRadius: "3px", cursor: "pointer",
            }}
          >
            {SLOT_LABELS[slot] ?? slot}
          </button>
        ))}
      </div>

      {/* Method filter */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ color: "#555", fontSize: "11px", letterSpacing: "0.05em", minWidth: "48px" }}>METHOD</span>
        <button
          onClick={() => onChange({ ...filters, methods: [] })}
          style={{
            padding: "3px 10px", fontSize: "11px",
            background: methods.length === 0 ? "#3a3a3a" : "transparent",
            color: methods.length === 0 ? "#ddd" : "#555",
            border: `1px solid ${methods.length === 0 ? "#666" : "#333"}`,
            borderRadius: "3px", cursor: "pointer",
          }}
        >
          All
        </button>
        {allMethods.map((method) => {
          const color = METHOD_COLORS[method] ?? "#888";
          const icon  = METHOD_ICONS[method] ?? "?";
          const active = methods.includes(method);
          return (
            <button
              key={method}
              onClick={() => toggleMethod(method)}
              style={{
                padding: "3px 10px", fontSize: "11px",
                background: active ? color + "22" : "transparent",
                color: active ? color : "#555",
                border: `1px solid ${active ? color : "#333"}`,
                borderRadius: "3px", cursor: "pointer",
              }}
            >
              {icon} {method.replace("_", " ")}
            </button>
          );
        })}
      </div>

      {/* Min listings + sort */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "#555", fontSize: "11px", letterSpacing: "0.05em" }}>MIN LISTINGS</span>
          <input
            type="number"
            min={0}
            value={minListings}
            onChange={(e) => onChange({ ...filters, minListings: Math.max(0, Number(e.target.value) || 0) })}
            style={{
              width: "56px", padding: "3px 8px", background: "#111", color: "#ddd",
              border: "1px solid #333", borderRadius: "3px", fontSize: "12px",
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "#555", fontSize: "11px", letterSpacing: "0.05em" }}>SORT BY</span>
          {[["profit", "Profit"], ["roi", "ROI %"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => onChange({ ...filters, sortBy: val })}
              style={{
                padding: "3px 10px", fontSize: "11px",
                background: sortBy === val ? "#2a3a4a" : "transparent",
                color: sortBy === val ? "#6bbbe3" : "#555",
                border: `1px solid ${sortBy === val ? "#6bbbe3" : "#333"}`,
                borderRadius: "3px", cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top opportunities list
// ---------------------------------------------------------------------------

const DEFAULT_SHOW = 10;

function TopOpportunities({ cells, onSelect, filters }) {
  const { divine_price } = useEconomy();
  const divinePrice = divine_price || 150;
  const [showAll, setShowAll] = useState(false);

  const { slots, methods, minListings, sortBy } = filters;

  const filtered = useMemo(() => {
    return cells.filter((c) => {
      if (c.profitData.uncomputable || c.profitData.pending) return false;
      if (c.profitData.profit <= 0) return false;
      if (slots.length > 0 && !slots.includes(c.target.slot)) return false;
      if (methods.length > 0 && !methods.includes(c.profitData.bestRoute?.method)) return false;
      const listings = c.target.price_data?.total_listings ?? 0;
      if (listings < minListings) return false;
      return true;
    }).sort((a, b) => {
      if (sortBy === "roi") return b.profitData.roi - a.profitData.roi;
      return b.profitData.profit - a.profitData.profit;
    });
  }, [cells, slots, methods, minListings, sortBy]);

  const visible = showAll ? filtered : filtered.slice(0, DEFAULT_SHOW);

  if (filtered.length === 0) {
    return (
      <div style={{ color: "#555", fontSize: "13px", padding: "16px 0" }}>
        No profitable opportunities match the current filters.
        {cells.every(c => c.profitData.pending || !c.target.price_data) && (
          <span> Run <code style={{ color: "#e2b659" }}>fetch_trade_prices.py</code> to refresh.</span>
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {visible.map((cell, i) => {
          const { target, profitData } = cell;
          const icon = METHOD_ICONS[profitData.bestRoute.method] ?? "?";
          const methodColor = METHOD_COLORS[profitData.bestRoute.method] ?? "#888";
          const isSparse = target.price_data?.total_listings < SPARSE_LISTING_THRESHOLD;
          const rank = showAll ? i + 1 : i + 1;

          return (
            <div
              key={target.id}
              onClick={() => onSelect(cell)}
              style={{
                display: "flex", alignItems: "center", gap: "12px",
                padding: "10px 14px", background: "#1a1a1a",
                border: "1px solid #333", borderRadius: "6px",
                cursor: "pointer",
              }}
            >
              <div style={{ color: "#555", fontSize: "13px", minWidth: "22px" }}>#{rank}</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#ddd", fontSize: "13px", fontWeight: "bold", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  {target.build} — {SLOT_LABELS[target.slot] ?? target.slot}
                  {profitData.commonBase && (
                    <span style={{ color: "#5a4a30", fontWeight: "normal", fontSize: "11px" }}>
                      {profitData.commonBase}
                    </span>
                  )}
                  {profitData.isFracturedBase && (
                    <span style={{
                      color: "#000", background: FRACTURED_COLOR, fontSize: "9px",
                      letterSpacing: "0.06em", padding: "1px 5px", borderRadius: "2px",
                      fontFamily: "sans-serif",
                    }}>
                      FRACTURED
                    </span>
                  )}
                  {isSparse && (
                    <span style={{ color: "#c08000", fontSize: "11px" }} title={`Only ${target.price_data.total_listings} listings`}>
                      ⚠ {target.price_data.total_listings} listings
                    </span>
                  )}
                </div>
                <div style={{ color: "#666", fontSize: "11px", marginTop: "2px" }}>
                  <span style={{ color: methodColor }}>{icon} {profitData.bestRoute.label}</span>
                  {" · "}Roll {formatChaos(profitData.rollCost, divinePrice)}
                  {profitData.baseCost > 0
                    ? <span> + base {formatChaos(profitData.baseCost, divinePrice)}</span>
                    : <span style={{ color: "#444" }}> + base unknown</span>}
                  {" · "}Sell {formatChaos(profitData.sellPrice, divinePrice)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{
                  color: profitData.baseCost === 0 ? "#7a8a60" : "#4CAF50",
                  fontWeight: "bold", fontSize: "15px",
                }}>
                  +{formatChaos(profitData.profit, divinePrice)}
                  {profitData.baseCost === 0 && <span style={{ color: "#444", fontSize: "10px" }}> -base</span>}
                </div>
                <div style={{ color: "#555", fontSize: "11px" }}>
                  {(profitData.roi * 100).toFixed(0)}% ROI{profitData.baseCost === 0 ? "*" : ""}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length > DEFAULT_SHOW && (
        <button
          onClick={() => setShowAll(v => !v)}
          style={{
            marginTop: "10px", width: "100%", padding: "8px",
            background: "transparent", color: "#555", border: "1px solid #333",
            borderRadius: "4px", cursor: "pointer", fontSize: "12px",
          }}
        >
          {showAll
            ? `Show fewer`
            : `Show all ${filtered.length} opportunities`}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main ProfitHeatmap component
// ---------------------------------------------------------------------------

function _initialCells() {
  const priced = tradePricesData.targets
    .filter((t) => t.price_data)
    .map((target) => ({
      target,
      profitData: { pending: true, sellPrice: target.price_data.median },
    }))
    .sort((a, b) => b.profitData.sellPrice - a.profitData.sellPrice);

  const unpriced = tradePricesData.targets
    .filter((t) => !t.price_data)
    .map((target) => ({
      target,
      profitData: { uncomputable: true, reason: "no_price_data" },
    }));

  return [...priced, ...unpriced];
}

function _resortCells(cells) {
  return [...cells].sort((a, b) => {
    const pa = a.profitData.pending || a.profitData.uncomputable ? -Infinity : a.profitData.profit;
    const pb = b.profitData.pending || b.profitData.uncomputable ? -Infinity : b.profitData.profit;
    return pb - pa;
  });
}

export default function ProfitHeatmap() {
  const [selectedCell, setSelectedCell] = useState(null);
  const [viewMode, setViewMode] = useState("top"); // "top" | "grid"
  const [cells, setCells] = useState(_initialCells);
  const [filters, setFilters] = useState({
    slots: [],
    methods: [],
    minListings: 0,
    sortBy: "profit",
  });

  useEffect(() => {
    let cancelled = false;
    const targets = tradePricesData.targets.filter((t) => t.price_data);

    function processNext(idx) {
      if (cancelled || idx >= targets.length) return;
      const target = targets[idx];
      const profitData = computeTargetProfit(target);

      if (!cancelled) {
        setCells((prev) => {
          const updated = prev.map((c) =>
            c.target.id === target.id ? { ...c, profitData } : c
          );
          return _resortCells(updated);
        });
      }

      const schedule =
        typeof requestIdleCallback !== "undefined"
          ? (fn) => requestIdleCallback(fn, { timeout: 500 })
          : (fn) => setTimeout(fn, 0);
      schedule(() => processNext(idx + 1));
    }

    processNext(0);
    return () => { cancelled = true; };
  }, []);

  const { divine_price } = useEconomy();
  const divinePrice = divine_price || 150;

  const builds = useMemo(() => {
    const seen = new Map();
    cells.forEach(({ target }) => {
      if (!seen.has(target.build)) seen.set(target.build, target.play_pct);
    });
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b);
  }, [cells]);

  const slots = useMemo(() => {
    const present = new Set(cells.map((c) => c.target.slot));
    return SLOT_ORDER.filter((s) => present.has(s));
  }, [cells]);

  const allMethods = useMemo(() => {
    const seen = new Set();
    cells.forEach((c) => {
      if (!c.profitData.uncomputable && !c.profitData.pending && c.profitData.bestRoute) {
        seen.add(c.profitData.bestRoute.method);
      }
    });
    return [...seen];
  }, [cells]);

  const cellIndex = useMemo(() => {
    const idx = {};
    cells.forEach((cell) => {
      idx[`${cell.target.build}||${cell.target.slot}`] = cell;
    });
    return idx;
  }, [cells]);

  const pricedCount    = cells.filter((c) => c.target.price_data).length;
  const computedCount  = cells.filter((c) => !c.profitData.pending && !c.profitData.uncomputable).length;
  const profitableCount = cells.filter(
    (c) => !c.profitData.pending && !c.profitData.uncomputable && c.profitData.profit > 0
  ).length;

  // Grid filtered by selected method (highlight matching cells)
  const gridMethodFilter = filters.methods.length > 0 ? filters.methods : null;

  return (
    <div style={{ position: "relative" }}>
      {/* Summary bar */}
      <div style={{
        background: "#1e1e1e", border: "1px solid #333", borderRadius: "6px",
        padding: "10px 16px", marginBottom: "16px",
        display: "flex", gap: "24px", flexWrap: "wrap", fontSize: "13px", color: "#aaa",
      }}>
        <span>League: <strong style={{ color: "#e2b659" }}>{tradePricesData.league}</strong></span>
        <span>Priced targets: <strong style={{ color: "#ddd" }}>{pricedCount}</strong></span>
        <span>
          {computedCount < pricedCount
            ? <span style={{ color: "#666" }}>Computing… <strong style={{ color: "#888" }}>{computedCount}/{pricedCount}</strong></span>
            : <span>Profitable: <strong style={{ color: "#4CAF50" }}>{profitableCount}</strong></span>
          }
        </span>
        <span>Divine: <strong style={{ color: "#e2b659" }}>{divinePrice}c</strong></span>
        <span style={{ color: "#444", fontSize: "12px", marginLeft: "auto" }}>
          Fetched: {new Date(tradePricesData.fetched_at).toLocaleString()}
        </span>
      </div>

      {/* Filter bar */}
      <FilterBar
        allSlots={slots}
        allMethods={allMethods}
        filters={filters}
        onChange={setFilters}
      />

      {/* View toggle */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        {[["top", "Top Opportunities"], ["grid", "Grid View"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setViewMode(id)}
            style={{
              padding: "6px 16px", fontSize: "13px",
              background: viewMode === id ? "#4CAF50" : "#2a2a2a",
              color:      viewMode === id ? "#000"    : "#aaa",
              border:     viewMode === id ? "none"    : "1px solid #444",
              borderRadius: "4px", cursor: "pointer", fontWeight: "bold",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Top opportunities */}
      {viewMode === "top" && (
        <TopOpportunities cells={cells} onSelect={setSelectedCell} filters={filters} />
      )}

      {/* Grid view */}
      {viewMode === "grid" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "separate", borderSpacing: "4px", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", color: "#555", fontSize: "12px", padding: "4px 8px", fontWeight: "normal" }}>
                  Build
                </th>
                {slots.map((slot) => (
                  <th key={slot} style={{
                    color: filters.slots.includes(slot) ? "#4CAF50" : "#888",
                    fontSize: "11px", padding: "4px 6px",
                    fontWeight: "normal", textAlign: "center", minWidth: "72px",
                  }}>
                    {SLOT_LABELS[slot] ?? slot}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {builds.map((build) => {
                // Slot filter: dim row if no visible slots match
                const rowHasMatch = slots.length === 0 || slots.some((s) => {
                  const c = cellIndex[`${build}||${s}`];
                  return c && !c.profitData.uncomputable && !c.profitData.pending;
                });
                return (
                  <tr key={build} style={{ opacity: rowHasMatch ? 1 : 0.4 }}>
                    <td
                      title={build}
                      style={{
                        color: "#bbb", fontSize: "12px", padding: "4px 8px",
                        whiteSpace: "nowrap", maxWidth: "200px", overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {build}
                    </td>
                    {slots.map((slot) => {
                      const cell = cellIndex[`${build}||${slot}`];
                      const dimmed = gridMethodFilter &&
                        cell?.profitData?.bestRoute &&
                        !gridMethodFilter.includes(cell.profitData.bestRoute.method);
                      return (
                        <td key={slot} style={{ padding: "0", opacity: dimmed ? 0.2 : 1 }}>
                          {cell ? (
                            <HeatmapCell
                              cell={cell}
                              onClick={setSelectedCell}
                              isSelected={selectedCell?.target.id === cell.target.id}
                            />
                          ) : (
                            <div style={{
                              minHeight: "48px", background: "#141414",
                              border: "1px solid #222", borderRadius: "4px",
                            }} />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "12px", fontSize: "11px", color: "#555" }}>
            <span><span style={{ color: "#4CAF50" }}>■</span> &gt;1000c profit</span>
            <span><span style={{ color: "#2d8c2d" }}>■</span> 200–1000c</span>
            <span><span style={{ color: "#1a5a1a" }}>■</span> 20–200c</span>
            <span><span style={{ color: "#777" }}>■</span> breakeven</span>
            <span><span style={{ color: "#4a1414" }}>■</span> loss</span>
            <span><span style={{ color: "#5a4a70" }}>■</span> N/A (dual-influence)</span>
            <span><span style={{ color: "#2a2a2a" }}>■</span> no data</span>
            <span><span style={{ color: "#c08000" }}>⚠</span> sparse listings (&lt;{SPARSE_LISTING_THRESHOLD})</span>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selectedCell && (
        <>
          <div
            onClick={() => setSelectedCell(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 99 }}
          />
          <DetailPanel cell={selectedCell} onClose={() => setSelectedCell(null)} />
        </>
      )}
    </div>
  );
}
