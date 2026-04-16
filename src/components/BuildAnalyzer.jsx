import { useState } from "react";
import { useEconomy } from "../contexts/EconomyContext";
import buildItemsData from "../data/build_items.json";
import tradePricesData from "../data/trade_prices.json";
import { INFLUENCES, ELEMENTAL_RESIST_GROUPS, SLOT_LABELS, freqColor } from "../constants";

// ---------------------------------------------------------------------------
// ProfitabilityPanel — market price summary for a (build, slot) pair
// ---------------------------------------------------------------------------

function ProfitabilityPanel({ slot, build, tradeTargets }) {
  const economyData = useEconomy();
  const buildLabel = `${build.char_class} / ${build.primary_skill}`;
  const target = tradeTargets.find(
    (t) => t.build === buildLabel && t.slot === slot
  );
  const priceData = target?.price_data;

  if (!target) {
    return (
      <div style={{ fontSize: "12px", color: "#555", fontStyle: "italic", marginTop: "8px" }}>
        No trade data — run fetch_trade_prices.py to populate market values.
      </div>
    );
  }

  const divinePrice = economyData.divine_price || 150;
  const medianChaos = priceData?.median ?? null;
  const medianDivines = medianChaos != null ? (medianChaos / divinePrice).toFixed(1) : null;
  const inf = target.influence;

  return (
    <div style={{
      marginTop: "10px",
      padding: "10px 14px",
      background: "#0f1a0f",
      border: "1px solid #2a4a2a",
      borderRadius: "6px",
      fontSize: "13px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ color: "#4CAF50", fontWeight: "bold", fontSize: "12px", letterSpacing: "0.05em" }}>
          MARKET PRICE
        </span>
        {inf && (
          <span style={{
            fontSize: "11px", fontWeight: "bold",
            color: INFLUENCES.find(i => i.id === inf)?.color ?? "#aaa",
            border: `1px solid ${INFLUENCES.find(i => i.id === inf)?.color ?? "#444"}`,
            borderRadius: "3px", padding: "1px 6px",
          }}>
            {inf.toUpperCase()}
          </span>
        )}
      </div>

      {priceData ? (
        <>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            {[["p10", "Floor"], ["median", "Median"], ["p90", "Ceiling"]].map(([key, label]) => (
              <div key={key} style={{ textAlign: "center" }}>
                <div style={{ color: "#888", fontSize: "11px" }}>{label}</div>
                <div style={{ color: key === "median" ? "#e2b659" : "#ddd", fontWeight: key === "median" ? "bold" : "normal", fontSize: key === "median" ? "15px" : "13px" }}>
                  {priceData[key]}c
                </div>
              </div>
            ))}
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "#888", fontSize: "11px" }}>Listings</div>
              <div style={{ color: "#ddd", fontSize: "13px" }}>{priceData.total_listings}</div>
            </div>
          </div>
          {medianDivines && (
            <div style={{ marginTop: "8px", color: "#888", fontSize: "12px" }}>
              ≈ {medianDivines} div · {priceData.sampled} sampled
            </div>
          )}
          <div style={{ marginTop: "10px", color: "#555", fontSize: "11px" }}>
            Required mods: {target.required_mods.map(m => m.group).join(" · ")}
          </div>
        </>
      ) : (
        <div style={{ color: "#666", fontSize: "12px" }}>
          Trade query had 0 results — mods may be too strict for current market.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// mergeResistGroups — collapse fire/cold/lightning into one harvest-swappable row
// ---------------------------------------------------------------------------

function mergeResistGroups(modFreq) {
  const resistEntries = Object.entries(modFreq).filter(([g]) => ELEMENTAL_RESIST_GROUPS.has(g));
  if (resistEntries.length <= 1) return modFreq;

  let totalCount = 0, weightedTierSum = 0, minTier = Infinity, maxFreq = 0;
  for (const [, stats] of resistEntries) {
    totalCount += stats.count;
    if (stats.avg_tier != null) weightedTierSum += stats.avg_tier * stats.count;
    if (stats.min_tier_seen != null) minTier = Math.min(minTier, stats.min_tier_seen);
    maxFreq = Math.max(maxFreq, stats.frequency_pct);
  }
  const merged = {
    count: totalCount,
    frequency_pct: maxFreq,
    avg_tier: totalCount > 0 ? Math.round((weightedTierSum / totalCount) * 10) / 10 : null,
    min_tier_seen: isFinite(minTier) ? minTier : null,
    _sub: resistEntries,
  };

  const out = {};
  for (const [g, stats] of Object.entries(modFreq)) {
    if (!ELEMENTAL_RESIST_GROUPS.has(g)) out[g] = stats;
    else if (!out["Elemental Resistance"]) out["Elemental Resistance"] = merged;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SlotDetail — mod frequency bars + profitability panel for one slot
// ---------------------------------------------------------------------------

function SlotDetail({ slotKey, slotData, build, tradeTargets, onCraftThis }) {
  const [expandResists, setExpandResists] = useState(false);
  const mods = Object.entries(mergeResistGroups(slotData.mod_frequency ?? {}));

  const rawFreq = slotData.mod_frequency ?? {};
  const topGroups = Object.entries(rawFreq).filter(([, s]) => s.frequency_pct >= 40);
  const topResistCount = topGroups.filter(([g]) => ELEMENTAL_RESIST_GROUPS.has(g)).length;
  const craftModCount = topGroups.length - Math.max(0, topResistCount - 1);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <span style={{ fontSize: "12px", color: "#555" }}>
          n={slotData.sample_count} · T# = avg tier across ladder
        </span>
        {craftModCount > 0 && (
          <button
            onClick={() => onCraftThis(slotKey, rawFreq)}
            style={{
              padding: "5px 12px",
              fontSize: "12px",
              background: "#1a3a1a",
              color: "#4CAF50",
              border: "1px solid #4CAF50",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: "bold",
            }}
          >
            Craft this slot → ({craftModCount} mods)
          </button>
        )}
      </div>

      {mods.map(([group, stats]) => {
        const pct = stats.frequency_pct;
        const color = freqColor(pct);
        const isResistGroup = group === "Elemental Resistance";
        return (
          <div key={group} style={{ marginBottom: "9px" }}>
            <div
              style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "3px", cursor: isResistGroup ? "pointer" : "default" }}
              onClick={isResistGroup ? () => setExpandResists(v => !v) : undefined}
            >
              <span style={{ color: "#ddd" }}>
                {group}
                {isResistGroup && <span style={{ color: "#555", fontSize: "11px", marginLeft: "6px" }}>harvest-swappable {expandResists ? "▼" : "▶"}</span>}
              </span>
              <span style={{ fontSize: "12px" }}>
                {stats.avg_tier != null && (
                  <span style={{ color: "#e2b659", marginRight: "8px" }}>T{stats.avg_tier}</span>
                )}
                <span style={{ color }}>{pct}%</span>
              </span>
            </div>
            <div style={{ height: "4px", background: "#333", borderRadius: "2px", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: color, borderRadius: "2px" }} />
            </div>
            {isResistGroup && expandResists && stats._sub && (
              <div style={{ marginTop: "6px", paddingLeft: "12px", borderLeft: "2px solid #333" }}>
                {stats._sub.map(([subGroup, subStats]) => (
                  <div key={subGroup} style={{ marginBottom: "5px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "2px" }}>
                      <span style={{ color: "#999" }}>{subGroup}</span>
                      <span>
                        {subStats.avg_tier != null && <span style={{ color: "#c49a3a", marginRight: "6px" }}>T{subStats.avg_tier}</span>}
                        <span style={{ color: freqColor(subStats.frequency_pct) }}>{subStats.frequency_pct}%</span>
                      </span>
                    </div>
                    <div style={{ height: "3px", background: "#2a2a2a", borderRadius: "2px", overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(subStats.frequency_pct, 100)}%`, height: "100%", background: freqColor(subStats.frequency_pct), borderRadius: "2px" }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <ProfitabilityPanel slot={slotKey} build={build} tradeTargets={tradeTargets} />

      <div style={{ marginTop: "12px", fontSize: "12px", color: "#555", display: "flex", gap: "16px", flexWrap: "wrap", borderTop: "1px solid #1e1e1e", paddingTop: "8px" }}>
        <span><span style={{ color: "#4CAF50" }}>■</span> ≥70% core</span>
        <span><span style={{ color: "#e2b659" }}>■</span> ≥40% common</span>
        <span><span style={{ color: "#6bbbe3" }}>■</span> ≥20% situational</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BuildDetail — slot tab strip + active slot detail
// ---------------------------------------------------------------------------

function BuildDetail({ build, tradeTargets, onCraftThis }) {
  const slotKeys = Object.keys(build.slots);
  const [activeSlot, setActiveSlot] = useState(slotKeys[0] ?? null);

  if (slotKeys.length === 0) {
    return <div style={{ color: "#666", fontSize: "13px", padding: "12px 0" }}>No slot data for this build.</div>;
  }

  return (
    <div style={{ marginTop: "14px" }}>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "14px" }}>
        {slotKeys.map((sk) => {
          const hasTrade = tradeTargets.some(
            t => t.build === `${build.char_class} / ${build.primary_skill}` && t.slot === sk
          );
          return (
            <button
              key={sk}
              onClick={() => setActiveSlot(sk)}
              style={{
                padding: "5px 11px",
                fontSize: "12px",
                background: activeSlot === sk ? "#c77be3" : "#2d2d2d",
                color: activeSlot === sk ? "#000" : "#aaa",
                border: activeSlot === sk ? "none" : `1px solid ${hasTrade ? "#2a4a2a" : "#444"}`,
                borderRadius: "3px",
                cursor: "pointer",
                fontWeight: activeSlot === sk ? "bold" : "normal",
              }}
            >
              {SLOT_LABELS[sk] ?? sk}
              {hasTrade && activeSlot !== sk && (
                <span style={{ marginLeft: "4px", color: "#4CAF50", fontSize: "10px" }}>●</span>
              )}
            </button>
          );
        })}
      </div>

      {activeSlot && build.slots[activeSlot] && (
        <SlotDetail
          slotKey={activeSlot}
          slotData={build.slots[activeSlot]}
          build={build}
          tradeTargets={tradeTargets}
          onCraftThis={onCraftThis}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AscendancyRow — collapsible row with build list + active build detail
// ---------------------------------------------------------------------------

function AscendancyRow({ ascendancy, builds, tradeTargets, onCraftThis }) {
  const totalChars = builds.reduce((s, b) => s + b.count, 0);
  const topPlayPct = builds[0]?.play_pct ?? 0;
  const [expanded, setExpanded] = useState(false);
  const [activeBuildKey, setActiveBuildKey] = useState(null);

  return (
    <div style={{ marginBottom: "6px" }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "10px 16px",
          background: expanded ? "#1e1630" : "#1a1a1a",
          border: expanded ? "1px solid #6040a0" : "1px solid #333",
          borderRadius: expanded ? "6px 6px 0 0" : "6px",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ color: expanded ? "#c77be3" : "#ddd", fontWeight: "bold", fontSize: "15px", minWidth: "160px" }}>
          {ascendancy}
        </span>
        <span style={{ color: "#555", fontSize: "13px" }}>
          {builds.length} build{builds.length !== 1 ? "s" : ""}
        </span>
        <div style={{ flex: 1, height: "3px", background: "#2a2a2a", borderRadius: "2px", overflow: "hidden", maxWidth: "200px" }}>
          <div style={{ width: `${Math.min(topPlayPct * 3, 100)}%`, height: "100%", background: expanded ? "#c77be3" : "#555", borderRadius: "2px" }} />
        </div>
        <span style={{ color: "#888", fontSize: "12px", marginLeft: "auto" }}>
          {totalChars} chars
        </span>
        <span style={{ color: "#555", fontSize: "13px" }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{
          border: "1px solid #6040a0", borderTop: "none",
          borderRadius: "0 0 6px 6px", background: "#110e1a",
        }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", padding: "12px 16px", borderBottom: "1px solid #2a2a2a" }}>
            {builds.map((b) => {
              const key = b.char_class + b.primary_skill;
              const isActive = activeBuildKey === key;
              return (
                <button
                  key={key}
                  onClick={() => setActiveBuildKey(isActive ? null : key)}
                  style={{
                    padding: "7px 12px",
                    background: isActive ? "#2a1e40" : "#1a1a1a",
                    border: isActive ? "1px solid #c77be3" : "1px solid #333",
                    borderRadius: "4px",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <div style={{ color: isActive ? "#c77be3" : "#ccc", fontSize: "13px", fontWeight: isActive ? "bold" : "normal" }}>
                    {b.primary_skill}
                  </div>
                  <div style={{ color: freqColor(b.play_pct), fontSize: "11px", marginTop: "2px" }}>
                    {b.play_pct}% · {b.count} chars
                  </div>
                </button>
              );
            })}
          </div>

          {activeBuildKey && (() => {
            const b = builds.find(b => b.char_class + b.primary_skill === activeBuildKey);
            if (!b) return null;
            return (
              <div style={{ padding: "14px 18px" }}>
                <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "10px" }}>
                  {b.char_class} · {b.primary_skill} · {b.count} chars ({b.play_pct}% of ladder)
                </div>
                <BuildDetail build={b} tradeTargets={tradeTargets} onCraftThis={onCraftThis} />
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BuildAnalyzer — top-level component, exported
// ---------------------------------------------------------------------------

export default function BuildAnalyzer({ onCraftThis }) {
  const { league, analyzed_at, characters_sampled, builds } = buildItemsData;
  const tradeTargets = tradePricesData?.targets ?? [];
  const analyzedDate = new Date(analyzed_at).toLocaleString();

  const byAscendancy = builds.reduce((acc, b) => {
    if (!acc[b.char_class]) acc[b.char_class] = [];
    acc[b.char_class].push(b);
    return acc;
  }, {});
  const ascendancies = Object.entries(byAscendancy)
    .sort((a, b) => b[1].reduce((s, x) => s + x.count, 0) - a[1].reduce((s, x) => s + x.count, 0));

  return (
    <div>
      <div style={{
        background: "#1e1e1e", border: "1px solid #333", borderRadius: "6px",
        padding: "10px 16px", marginBottom: "16px",
        display: "flex", gap: "24px", flexWrap: "wrap", fontSize: "13px", color: "#aaa",
      }}>
        <span>League: <strong style={{ color: "#e2b659" }}>{league}</strong></span>
        <span>Characters sampled: <strong style={{ color: "#ddd" }}>{characters_sampled}</strong></span>
        <span>Analyzed: <strong style={{ color: "#ddd" }}>{analyzedDate}</strong></span>
        {tradeTargets.length > 0 && (
          <span>Trade targets: <strong style={{ color: "#4CAF50" }}>{tradeTargets.filter(t => t.price_data).length} priced</strong></span>
        )}
      </div>

      {ascendancies.map(([ascendancy, aBuilds]) => (
        <AscendancyRow
          key={ascendancy}
          ascendancy={ascendancy}
          builds={aBuilds}
          tradeTargets={tradeTargets}
          onCraftThis={onCraftThis}
        />
      ))}
    </div>
  );
}
