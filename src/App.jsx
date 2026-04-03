import { useState, useEffect } from "react";
import itemsData from "./data/items.json";
import essenceDataList from "./data/essences.json";
import fossilData from "./data/fossils.json";
import economyData from "./data/active_economy.json";
import buildItemsData from "./data/build_items.json";
import tradePricesData from "./data/trade_prices.json";
import { calculateSpamEV } from "./utils/calculator";

const SLOT_LABELS = {
  ring: "Ring",
  amulet: "Amulet",
  belt: "Belt",
  body_armour: "Body Armour",
  helmet: "Helmet",
  boots: "Boots",
  gloves: "Gloves",
};

function freqColor(pct) {
  if (pct >= 70) return "#4CAF50";
  if (pct >= 40) return "#e2b659";
  if (pct >= 20) return "#6bbbe3";
  return "#888";
}

// ---------------------------------------------------------------------------
// Build Analyzer — nested ascendancy → build → slot detail
// ---------------------------------------------------------------------------

function ProfitabilityPanel({ slot, build, tradeTargets }) {
  // Find the matching trade target for this (build, slot) if available
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

function SlotDetail({ slotKey, slotData, build, tradeTargets }) {
  const mods = Object.entries(slotData.mod_frequency ?? {});
  return (
    <div>
      <div style={{ fontSize: "12px", color: "#555", marginBottom: "10px" }}>
        n={slotData.sample_count} · T# = avg tier across ladder
      </div>

      {mods.map(([group, stats]) => {
        const pct = stats.frequency_pct;
        const color = freqColor(pct);
        return (
          <div key={group} style={{ marginBottom: "9px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "3px" }}>
              <span style={{ color: "#ddd" }}>{group}</span>
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

function BuildDetail({ build, tradeTargets }) {
  const slotKeys = Object.keys(build.slots);
  const [activeSlot, setActiveSlot] = useState(slotKeys[0] ?? null);

  if (slotKeys.length === 0) {
    return <div style={{ color: "#666", fontSize: "13px", padding: "12px 0" }}>No slot data for this build.</div>;
  }

  return (
    <div style={{ marginTop: "14px" }}>
      {/* Slot tab strip */}
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
        />
      )}
    </div>
  );
}

function AscendancyRow({ ascendancy, builds, tradeTargets }) {
  const totalChars = builds.reduce((s, b) => s + b.count, 0);
  const topPlayPct = builds[0]?.play_pct ?? 0;
  const [expanded, setExpanded] = useState(false);
  const [activeBuildKey, setActiveBuildKey] = useState(null);

  return (
    <div style={{ marginBottom: "6px" }}>
      {/* Ascendancy header row */}
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
          {/* Build list */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", padding: "12px 16px", borderBottom: "1px solid #2a2a2a" }}>
            {builds.map((b) => {
              const key = b.char_class + b.primary_skill;
              const isActive = activeBuildKey === key;
              return (
                <button
                  key={key}
                  onClick={() => setActiveBuildKey(isActive ? null : key)}
                  style={{
                    padding: "7px 13px",
                    background: isActive ? "#2d1f3d" : "#1e1e1e",
                    border: isActive ? "1px solid #c77be3" : "1px solid #3a3a3a",
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

          {/* Active build detail */}
          {activeBuildKey && (() => {
            const b = builds.find(b => b.char_class + b.primary_skill === activeBuildKey);
            if (!b) return null;
            return (
              <div style={{ padding: "14px 18px" }}>
                <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "10px" }}>
                  {b.char_class} · {b.primary_skill} · {b.count} chars ({b.play_pct}% of ladder)
                </div>
                <BuildDetail build={b} tradeTargets={tradeTargets} />
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function BuildAnalyzer() {
  const { league, analyzed_at, characters_sampled, builds } = buildItemsData;
  const tradeTargets = tradePricesData?.targets ?? [];
  const analyzedDate = new Date(analyzed_at).toLocaleString();

  // Group builds by ascendancy, sorted by total chars descending
  const byAscendancy = builds.reduce((acc, b) => {
    if (!acc[b.char_class]) acc[b.char_class] = [];
    acc[b.char_class].push(b);
    return acc;
  }, {});
  const ascendancies = Object.entries(byAscendancy)
    .sort((a, b) => b[1].reduce((s, x) => s + x.count, 0) - a[1].reduce((s, x) => s + x.count, 0));

  return (
    <div>
      {/* Summary bar */}
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

      {/* Ascendancy list */}
      {ascendancies.map(([ascendancy, aBuilds]) => (
        <AscendancyRow
          key={ascendancy}
          ascendancy={ascendancy}
          builds={aBuilds}
          tradeTargets={tradeTargets}
        />
      ))}
    </div>
  );
}

const INFLUENCES = [
  { id: "shaper",   label: "Shaper",   color: "#7bafdd" },
  { id: "elder",    label: "Elder",    color: "#c77be3" },
  { id: "crusader", label: "Crusader", color: "#e2c060" },
  { id: "hunter",   label: "Hunter",   color: "#7ec87e" },
  { id: "redeemer", label: "Redeemer", color: "#63c7b8" },
  { id: "warlord",  label: "Warlord",  color: "#e27b7b" },
];

function App() {
  const [activeTab, setActiveTab] = useState("crafter");
  const [selectedItemClass, setSelectedItemClass] = useState("ring");
  const [selectedInfluence, setSelectedInfluence] = useState(null);
  const [craftingMethod, setCraftingMethod] = useState("essence");
  const [fracturedModId, setFracturedModId] = useState("none");
  const [selectedEssenceId, setSelectedEssenceId] = useState(
    "deafening_essence_of_spite",
  );
  const [activeFossils, setActiveFossils] = useState([]);
  const [targetIds, setTargetIds] = useState([]);
  const [result, setResult] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});

  const [baseCostChaos, setBaseCostChaos] = useState(50);
  const [marketValueDivines, setMarketValueDivines] = useState(10);

  // Read economy values
  const divinePrice = economyData.divine_price || 150;
  const essenceData = essenceDataList[selectedEssenceId];
  const guaranteedModId =
    craftingMethod === "essence"
      ? essenceData?.guaranteed_mods?.[selectedItemClass]
      : null;

  // Influence-filtered pools: base mods always included; influence mods only when matching
  const allPrefixes = itemsData[selectedItemClass]?.prefixes || [];
  const allSuffixes = itemsData[selectedItemClass]?.suffixes || [];
  const currentPrefixPool = allPrefixes.filter(
    (m) => !m.influence || m.influence === selectedInfluence,
  );
  const currentSuffixPool = allSuffixes.filter(
    (m) => !m.influence || m.influence === selectedInfluence,
  );

  useEffect(() => {
    setTargetIds([]);
    setFracturedModId("none");
    setResult(null);
    setExpandedGroups({});
  }, [selectedItemClass]);

  // Reset targets when influence changes — influenced mods may no longer be in pool
  useEffect(() => {
    setTargetIds([]);
    setFracturedModId("none");
    setResult(null);
    setExpandedGroups({});
  }, [selectedInfluence]);

  useEffect(() => {
    if (guaranteedModId) {
      setTargetIds((prev) =>
        prev.filter((id) => id !== guaranteedModId && id !== fracturedModId),
      );
    }
  }, [guaranteedModId, fracturedModId, craftingMethod]);

  const handleCalculate = () => {
    const fossilsToPass = craftingMethod === "fossil" ? activeFossils : [];
    const evData = calculateSpamEV(
      targetIds,
      selectedEssenceId,
      selectedItemClass,
      fracturedModId,
      fossilsToPass,
      selectedInfluence,
    );
    setResult(evData);
  };

  const toggleTarget = (modId, groupName) => {
    setTargetIds((prev) => {
      const groupIds = [...currentPrefixPool, ...currentSuffixPool]
        .filter((m) => m.group === groupName)
        .map((m) => m.id);
      const withoutGroup = prev.filter((id) => !groupIds.includes(id));
      if (prev.includes(modId)) return withoutGroup; // deselect
      return [...withoutGroup, modId];
    });
  };

  const toggleGroup = (groupName) => {
    setExpandedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }));
  };

  const toggleFossil = (fossilId) => {
    setActiveFossils((prev) => {
      if (prev.includes(fossilId)) return prev.filter((id) => id !== fossilId);
      if (prev.length >= 4) return prev;
      return [...prev, fossilId];
    });
  };

  const getModifiedPool = (pool, isFossilMode) => {
    return pool.map((mod) => {
      let finalWeight = mod.spawn_weights[0]?.weight || 0;

      if (isFossilMode && activeFossils.length > 0) {
        activeFossils.forEach((fId) => {
          const fData = fossilData[fId];
          if (!fData) return;

          let highestMult = 1;
          let hasZero = false;

          (mod.mod_tags || []).forEach((tag) => {
            if (fData.multipliers[tag] !== undefined) {
              const mult = fData.multipliers[tag];
              if (mult === 0) hasZero = true;
              else if (mult > highestMult) highestMult = mult;
            }
          });

          if (hasZero) finalWeight = 0;
          else finalWeight *= highestMult;
        });
      }
      return { ...mod, currentWeight: finalWeight };
    });
  };

  const modifiedPrefixes = getModifiedPool(
    currentPrefixPool,
    craftingMethod === "fossil",
  );
  const modifiedSuffixes = getModifiedPool(
    currentSuffixPool,
    craftingMethod === "fossil",
  );

  const totalPrefixWeight = modifiedPrefixes.reduce(
    (sum, mod) => sum + mod.currentWeight,
    0,
  );
  const totalSuffixWeight = modifiedSuffixes.reduce(
    (sum, mod) => sum + mod.currentWeight,
    0,
  );

  const getGroupedMods = (pool) => {
    const groups = {};
    pool.forEach((mod) => {
      if (mod.id.startsWith("junk_")) return;
      if (!groups[mod.group]) groups[mod.group] = [];
      groups[mod.group].push(mod);
    });
    for (const group of Object.values(groups)) {
      group.sort((a, b) => (a.tier ?? Infinity) - (b.tier ?? Infinity));
    }
    return groups;
  };

  const renderGroupedList = (pool, modifiedPool) => {
    const groups = getGroupedMods(pool);

    return Object.entries(groups).map(([groupName, mods]) => {
      const hasActiveTarget = mods.some((m) => targetIds.includes(m.id));

      return (
        <div key={groupName} style={{ marginBottom: "5px" }}>
          <div
            onClick={() => toggleGroup(groupName)}
            style={{
              padding: "10px",
              backgroundColor: hasActiveTarget ? "#2a3a23" : "#333",
              border: hasActiveTarget ? "1px solid #4CAF50" : "1px solid #444",
              borderRadius: "4px",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              userSelect: "none",
            }}
          >
            <strong>{groupName}</strong>
            <span>{expandedGroups[groupName] ? "▼" : "▶"}</span>
          </div>

          {expandedGroups[groupName] && (
            <div style={{ padding: "5px 0 5px 15px" }}>
              {mods.map((mod) => {
                const isEssence =
                  craftingMethod === "essence" && mod.id === guaranteedModId;
                const isFracture = mod.id === fracturedModId;
                const isTargeted = targetIds.includes(mod.id);
                const modifiedMod = modifiedPool.find((m) => m.id === mod.id);
                const currentWeight = modifiedMod
                  ? modifiedMod.currentWeight
                  : 0;
                const isZeroWeight =
                  currentWeight === 0 && !isFracture && !isEssence;

                // Find the selected target in this group (if any)
                const selectedTargetId = targetIds.find((id) =>
                  mods.some((m) => m.id === id),
                );
                const selectedTarget = mods.find(
                  (m) => m.id === selectedTargetId,
                );
                // This mod qualifies if its tier <= selected target's tier
                const isQualifying =
                  selectedTarget &&
                  mod.tier !== undefined &&
                  selectedTarget.tier !== undefined &&
                  mod.tier <= selectedTarget.tier &&
                  !isTargeted;

                let bg = "#1e1e1e";
                let cursor = "pointer";
                const tierLabel =
                  mod.tier !== undefined ? ` [T${mod.tier}]` : "";

                if (isEssence) {
                  bg = "#4a235a";
                  cursor = "not-allowed";
                } else if (isFracture) {
                  bg = "#5a4f23";
                  cursor = "not-allowed";
                } else if (isZeroWeight) {
                  bg = "#3d1c1c";
                  cursor = "not-allowed";
                } else if (isTargeted) {
                  bg = "#4CAF50";
                } else if (isQualifying) {
                  bg = "#2a3a23";
                }

                const influenceInfo = mod.influence
                  ? INFLUENCES.find((inf) => inf.id === mod.influence)
                  : null;

                const suffix = isEssence
                  ? " (Essence)"
                  : isFracture
                    ? " (Fractured)"
                    : isZeroWeight
                      ? " (0 Weight)"
                      : "";

                return (
                  <div
                    key={mod.id}
                    onClick={() => {
                      if (!isEssence && !isFracture && !isZeroWeight)
                        toggleTarget(mod.id, groupName);
                    }}
                    style={{
                      padding: "8px",
                      marginBottom: "3px",
                      backgroundColor: bg,
                      borderRadius: "4px",
                      cursor: cursor,
                      fontSize: "13px",
                      userSelect: "none",
                      opacity: isZeroWeight ? 0.5 : 1,
                    }}
                  >
                    <span style={{ color: "#aaa", marginRight: "6px" }}>
                      {tierLabel}
                    </span>
                    {influenceInfo && (
                      <span style={{
                        fontSize: "10px",
                        fontWeight: "bold",
                        color: influenceInfo.color,
                        border: `1px solid ${influenceInfo.color}`,
                        borderRadius: "3px",
                        padding: "0 4px",
                        marginRight: "6px",
                        verticalAlign: "middle",
                      }}>
                        {influenceInfo.label.toUpperCase()}
                      </span>
                    )}
                    {mod.text}
                    {suffix}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    });
  };

  const getTargetStats = () => {
    return targetIds
      .map((tId) => {
        let isPrefix = true;
        let targetMod = currentPrefixPool.find((m) => m.id === tId);
        if (!targetMod) {
          targetMod = currentSuffixPool.find((m) => m.id === tId);
          isPrefix = false;
        }
        if (!targetMod) return null;

        const tTier = targetMod.tier;
        const modifiedPool = isPrefix ? modifiedPrefixes : modifiedSuffixes;
        let combinedWeight = 0;
        let qualifyingTiers = 0;

        modifiedPool.forEach((mod) => {
          if (mod.group !== targetMod.group) return;
          const qualifies =
            tTier !== undefined && mod.tier !== undefined
              ? mod.tier <= tTier
              : mod.id === tId;
          if (qualifies && mod.currentWeight > 0) {
            combinedWeight += mod.currentWeight;
            qualifyingTiers++;
          }
        });

        const totalPoolWeight = isPrefix ? totalPrefixWeight : totalSuffixWeight;
        const weightPercent =
          totalPoolWeight > 0 ? (combinedWeight / totalPoolWeight) * 100 : 0;

        return {
          id: tId,
          group: targetMod.group,
          type: isPrefix ? "Prefix" : "Suffix",
          tierString: tTier !== undefined ? (tTier === 1 ? "T1" : `T1–T${tTier}`) : "exact",
          tiersCount: qualifyingTiers,
          weight: combinedWeight,
          weightPercent: weightPercent.toFixed(3) + "%",
        };
      })
      .filter(Boolean);
  };

  const targetStats = getTargetStats();

  return (
    <div
      style={{
        padding: "20px",
        fontFamily: "sans-serif",
        maxWidth: "900px",
        margin: "0 auto",
        color: "#ddd",
      }}
    >
      <h1 style={{ marginBottom: "4px" }}>PoE Profit Crafter</h1>

      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        {[
          { id: "crafter", label: "Crafter" },
          { id: "builds", label: "Build Analyzer" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 18px",
              background: activeTab === tab.id ? "#4CAF50" : "#2d2d2d",
              color: activeTab === tab.id ? "#000" : "#aaa",
              border: activeTab === tab.id ? "none" : "1px solid #444",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: "bold",
              fontSize: "14px",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "builds" && <BuildAnalyzer />}

      {activeTab === "crafter" && <div
        style={{ background: "#2d2d2d", padding: "20px", borderRadius: "8px" }}
      >
        <div
          style={{
            marginBottom: "20px",
            paddingBottom: "15px",
            borderBottom: "1px solid #444",
          }}
        >
          <label
            style={{
              display: "block",
              fontWeight: "bold",
              color: "#fff",
              fontSize: "16px",
              marginBottom: "8px",
            }}
          >
            Select Item Base:
          </label>
          <select
            value={selectedItemClass}
            onChange={(e) => setSelectedItemClass(e.target.value)}
            style={{
              width: "100%",
              padding: "12px",
              background: "#111",
              color: "white",
              border: "1px solid #6bbbe3",
              fontSize: "16px",
              fontWeight: "bold",
            }}
          >
            <option value="ring">Ring</option>
            <option value="amulet">Amulet</option>
            <option value="belt">Belt</option>
            <option value="body_armour">Body Armour</option>
            <option value="helmet">Helmet</option>
            <option value="boots">Boots</option>
            <option value="gloves">Gloves</option>
          </select>

          <label
            style={{
              display: "block",
              fontWeight: "bold",
              color: "#fff",
              fontSize: "14px",
              marginTop: "12px",
              marginBottom: "6px",
            }}
          >
            Item Influence:
          </label>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button
              onClick={() => setSelectedInfluence(null)}
              style={{
                padding: "6px 14px",
                background: selectedInfluence === null ? "#555" : "#1e1e1e",
                color: selectedInfluence === null ? "#fff" : "#888",
                border: selectedInfluence === null ? "1px solid #888" : "1px solid #444",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: selectedInfluence === null ? "bold" : "normal",
              }}
            >
              None
            </button>
            {INFLUENCES.map(({ id, label, color }) => (
              <button
                key={id}
                onClick={() => setSelectedInfluence(selectedInfluence === id ? null : id)}
                style={{
                  padding: "6px 14px",
                  background: selectedInfluence === id ? color + "33" : "#1e1e1e",
                  color: selectedInfluence === id ? color : "#888",
                  border: `1px solid ${selectedInfluence === id ? color : "#444"}`,
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "13px",
                  fontWeight: selectedInfluence === id ? "bold" : "normal",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "15px", marginBottom: "15px" }}>
          <div style={{ flex: 1 }}>
            <label
              style={{ display: "block", fontSize: "14px", color: "#aaa" }}
            >
              Base Cost (Chaos)
            </label>
            <input
              type="number"
              value={baseCostChaos}
              onChange={(e) => setBaseCostChaos(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "8px",
                background: "#1e1e1e",
                color: "white",
                border: "1px solid #555",
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label
              style={{ display: "block", fontSize: "14px", color: "#aaa" }}
            >
              Sell Value (Divines)
            </label>
            <input
              type="number"
              value={marketValueDivines}
              onChange={(e) => setMarketValueDivines(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "8px",
                background: "#1e1e1e",
                color: "white",
                border: "1px solid #555",
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label
              style={{
                display: "block",
                fontWeight: "bold",
                color: "#e2b659",
                fontSize: "14px",
              }}
            >
              Fractured Mod:
            </label>
            <select
              value={fracturedModId}
              onChange={(e) => setFracturedModId(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                background: "#1e1e1e",
                color: "white",
                border: "1px solid #555",
              }}
            >
              <option value="none">None / Normal Base</option>
              <optgroup label="Prefixes">
                {currentPrefixPool.map((m) => (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled={m.id === guaranteedModId}
                  >
                    {m.text}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Suffixes">
                {currentSuffixPool.map((m) => (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled={m.id === guaranteedModId}
                  >
                    {m.text}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>

        <div
          style={{
            marginBottom: "20px",
            paddingBottom: "20px",
            borderBottom: "1px solid #444",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Crafting Method</h3>
          <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
            <button
              onClick={() => setCraftingMethod("essence")}
              style={{
                flex: 1,
                padding: "10px",
                background: craftingMethod === "essence" ? "#c77be3" : "#333",
                color: craftingMethod === "essence" ? "#000" : "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              Essences
            </button>
            <button
              onClick={() => setCraftingMethod("fossil")}
              style={{
                flex: 1,
                padding: "10px",
                background: craftingMethod === "fossil" ? "#e2b659" : "#333",
                color: craftingMethod === "fossil" ? "#000" : "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              Fossils
            </button>
          </div>

          {craftingMethod === "essence" && (
            <div>
              <select
                value={selectedEssenceId}
                onChange={(e) => setSelectedEssenceId(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px",
                  background: "#1e1e1e",
                  color: "white",
                  border: "1px solid #c77be3",
                }}
              >
                {Object.entries(essenceDataList).map(([key, data]) => (
                  <option key={key} value={key}>
                    {data.name} (
                    {(economyData.essences && economyData.essences[key]) || 3}c)
                  </option>
                ))}
              </select>
            </div>
          )}

          {craftingMethod === "fossil" && (
            <div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                {Object.entries(fossilData).map(([fossilId, data]) => {
                  const fossilCost =
                    (economyData.fossils && economyData.fossils[fossilId]) || 1;
                  return (
                    <button
                      key={fossilId}
                      onClick={() => toggleFossil(fossilId)}
                      style={{
                        padding: "10px 15px",
                        background: activeFossils.includes(fossilId)
                          ? "#e2b659"
                          : "#1e1e1e",
                        color: activeFossils.includes(fossilId)
                          ? "#000"
                          : "#aaa",
                        border: "1px solid #e2b659",
                        borderRadius: "4px",
                        cursor:
                          activeFossils.length >= 4 &&
                          !activeFossils.includes(fossilId)
                            ? "not-allowed"
                            : "pointer",
                        opacity:
                          activeFossils.length >= 4 &&
                          !activeFossils.includes(fossilId)
                            ? 0.5
                            : 1,
                      }}
                    >
                      {data.name} ({fossilCost}c)
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <h3 style={{ marginTop: 0 }}>Select Targets</h3>
        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div
              style={{
                borderBottom: "1px solid #555",
                paddingBottom: "5px",
                marginBottom: "10px",
                fontWeight: "bold",
                color: "#6bbbe3",
              }}
            >
              Prefixes (Total Weight: {totalPrefixWeight})
            </div>
            <div
              style={{
                paddingRight: "5px",
                display: "flex",
                flexDirection: "column",
                gap: "5px",
              }}
            >
              {renderGroupedList(currentPrefixPool, modifiedPrefixes)}
            </div>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <div
              style={{
                borderBottom: "1px solid #555",
                paddingBottom: "5px",
                marginBottom: "10px",
                fontWeight: "bold",
                color: "#6bbbe3",
              }}
            >
              Suffixes (Total Weight: {totalSuffixWeight})
            </div>
            <div
              style={{
                paddingRight: "5px",
                display: "flex",
                flexDirection: "column",
                gap: "5px",
              }}
            >
              {renderGroupedList(currentSuffixPool, modifiedSuffixes)}
            </div>
          </div>
        </div>

        {targetStats.length > 0 && (
          <div
            style={{
              marginBottom: "20px",
              background: "#1a1a1a",
              border: "1px solid #444",
              borderRadius: "4px",
              overflow: "hidden",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "14px",
                textAlign: "left",
              }}
            >
              <thead>
                <tr style={{ background: "#333", color: "#aaa" }}>
                  <th
                    style={{ padding: "10px", borderBottom: "1px solid #444" }}
                  >
                    AFFIXES
                  </th>
                  <th
                    style={{ padding: "10px", borderBottom: "1px solid #444" }}
                  >
                    Type
                  </th>
                  <th
                    style={{ padding: "10px", borderBottom: "1px solid #444" }}
                  >
                    Tier
                  </th>
                  <th
                    style={{ padding: "10px", borderBottom: "1px solid #444" }}
                  >
                    Tiers
                  </th>
                  <th
                    style={{ padding: "10px", borderBottom: "1px solid #444" }}
                  >
                    Weight
                  </th>
                  <th
                    style={{ padding: "10px", borderBottom: "1px solid #444" }}
                  >
                    Weight %
                  </th>
                </tr>
              </thead>
              <tbody>
                {targetStats.map((stat, idx) => (
                  <tr
                    key={stat.id}
                    style={{
                      borderBottom: "1px solid #333",
                      background: idx % 2 === 0 ? "#1e1e1e" : "#1a1a1a",
                    }}
                  >
                    <td
                      style={{
                        padding: "10px",
                        color: stat.type === "Prefix" ? "#c77be3" : "#6bbbe3",
                      }}
                    >
                      {stat.group}
                    </td>
                    <td style={{ padding: "10px" }}>{stat.type}</td>
                    <td style={{ padding: "10px" }}>{stat.tierString}</td>
                    <td style={{ padding: "10px" }}>{stat.tiersCount}</td>
                    <td style={{ padding: "10px", color: "#e2b659" }}>
                      {stat.weight}
                    </td>
                    <td style={{ padding: "10px" }}>{stat.weightPercent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <button
          onClick={handleCalculate}
          style={{
            width: "100%",
            padding: "15px",
            fontSize: "18px",
            background: "#4CAF50",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: "bold",
          }}
        >
          Calculate Final Result
        </button>

        {result && !result.error && (
          <div
            style={{
              marginTop: "20px",
              padding: "20px",
              border: "1px solid #555",
              background: "#111",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                borderBottom: "1px solid #333",
                paddingBottom: "10px",
                marginBottom: "10px",
              }}
            >
              <span style={{ color: "#aaa", fontWeight: "bold" }}>
                FINAL CALCULATION:
              </span>
              <strong style={{ fontSize: "18px", color: "#e2b659" }}>
                {result.probability} (~{result.averageTries} tries)
              </strong>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                paddingBottom: "5px",
              }}
            >
              <span style={{ color: "#aaa" }}>Base Item Cost:</span>
              <span>{baseCostChaos}c</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                paddingBottom: "10px",
                borderBottom: "1px solid #333",
                marginBottom: "10px",
              }}
            >
              <span style={{ color: "#aaa" }}>Crafting Cost:</span>
              <span>{result.expectedCostChaos}c</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "18px",
                fontWeight: "bold",
                borderTop: "2px solid #555",
                paddingTop: "15px",
              }}
            >
              <span>Expected Profit:</span>
              <span
                style={{
                  color:
                    marketValueDivines * divinePrice -
                      (baseCostChaos + result.expectedCostChaos) >
                    0
                      ? "#4CAF50"
                      : "#ff6666",
                }}
              >
                {Math.round(
                  marketValueDivines * divinePrice -
                    (baseCostChaos + result.expectedCostChaos),
                )}{" "}
                Chaos
              </span>
            </div>
          </div>
        )}

        {result?.error && (
          <div
            style={{
              marginTop: "20px",
              padding: "15px",
              border: "1px solid #ff6666",
              background: "#2a0000",
              color: "#ff6666",
            }}
          >
            <strong>Error:</strong> {result.error}
          </div>
        )}
      </div>}
    </div>
  );
}

export default App;
