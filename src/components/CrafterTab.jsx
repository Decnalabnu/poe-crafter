import { useState, useEffect, useRef } from "react";
import itemsData from "../data/items.json";
import essenceDataList from "../data/essences.json";
import fossilData from "../data/fossils.json";
import { useEconomy } from "../contexts/EconomyContext";
import { calculateSpamEV } from "../utils/calculator";
import { INFLUENCES, ELEMENTAL_RESIST_GROUPS } from "../constants";

// ---------------------------------------------------------------------------
// CrafterTab
//
// craftInit: null | { itemClass, influence, targetIds }
// craftInitKey: incremented by parent each time craftInit changes; triggers reset
// ---------------------------------------------------------------------------

export default function CrafterTab({ craftInit, craftInitKey }) {
  const economyData = useEconomy();

  const [selectedItemClass, setSelectedItemClass] = useState(craftInit?.itemClass ?? "ring");
  const [selectedInfluence, setSelectedInfluence]  = useState(craftInit?.influence ?? null);
  const [craftingMethod, setCraftingMethod]         = useState("essence");
  const [fracturedModId, setFracturedModId]         = useState("none");
  const [selectedEssenceId, setSelectedEssenceId]   = useState("deafening_essence_of_spite");
  const [activeFossils, setActiveFossils]           = useState([]);
  const [targetIds, setTargetIds]                   = useState(craftInit?.targetIds ?? []);
  const [itemLevel, setItemLevel]                   = useState(86);
  const [result, setResult]                         = useState(null);
  const [expandedGroups, setExpandedGroups]         = useState({});
  const [baseCostChaos, setBaseCostChaos]           = useState(50);
  const [marketValueDivines, setMarketValueDivines] = useState(10);

  // Apply external craft init when the parent increments craftInitKey
  const prevKeyRef = useRef(craftInitKey);
  useEffect(() => {
    if (craftInitKey !== prevKeyRef.current && craftInit) {
      prevKeyRef.current = craftInitKey;
      setSelectedItemClass(craftInit.itemClass);
      setSelectedInfluence(craftInit.influence);
      setTargetIds(craftInit.targetIds);
      setFracturedModId("none");
      setResult(null);
      setExpandedGroups({});
    }
  }, [craftInitKey, craftInit]);

  const divinePrice = economyData.divine_price || 150;
  const essenceData = essenceDataList[selectedEssenceId];
  const guaranteedModId =
    craftingMethod === "essence"
      ? essenceData?.guaranteed_mods?.[selectedItemClass]
      : null;

  const allPrefixes = itemsData[selectedItemClass]?.prefixes || [];
  const allSuffixes = itemsData[selectedItemClass]?.suffixes || [];

  const currentPrefixPool = allPrefixes.filter(
    (m) => (!m.influence || m.influence === selectedInfluence) &&
           (m.required_level ?? 0) <= itemLevel &&
           Object.values(m.base_weights ?? {}).some(w => w > 0),
  );
  const currentSuffixPool = allSuffixes.filter(
    (m) => (!m.influence || m.influence === selectedInfluence) &&
           (m.required_level ?? 0) <= itemLevel &&
           Object.values(m.base_weights ?? {}).some(w => w > 0),
  );

  // Reset targets when item class changes
  useEffect(() => {
    setTargetIds([]);
    setFracturedModId("none");
    setResult(null);
    setExpandedGroups({});
  }, [selectedItemClass]);

  // Reset targets when influence changes
  useEffect(() => {
    setTargetIds([]);
    setFracturedModId("none");
    setResult(null);
    setExpandedGroups({});
  }, [selectedInfluence]);

  // Remove guaranteed essence mod from targets when it changes
  useEffect(() => {
    if (guaranteedModId) {
      setTargetIds((prev) =>
        prev.filter((id) => id !== guaranteedModId && id !== fracturedModId),
      );
    }
  }, [guaranteedModId, fracturedModId, craftingMethod]);

  const handleCalculate = () => {
    const fossilsToPass = craftingMethod === "fossil" ? activeFossils : [];
    const essenceToPass = craftingMethod === "essence" ? selectedEssenceId : null;
    const evData = calculateSpamEV(
      targetIds,
      essenceToPass,
      selectedItemClass,
      fracturedModId,
      fossilsToPass,
      selectedInfluence,
      null,
      itemLevel,
    );
    setResult(evData);
  };

  const toggleTarget = (modId, groupName) => {
    setTargetIds((prev) => {
      const groupIds = [...currentPrefixPool, ...currentSuffixPool]
        .filter((m) => m.group === groupName)
        .map((m) => m.id);
      const withoutGroup = prev.filter((id) => !groupIds.includes(id));
      if (prev.includes(modId)) return withoutGroup;
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

  const modifiedPrefixes = getModifiedPool(currentPrefixPool, craftingMethod === "fossil");
  const modifiedSuffixes = getModifiedPool(currentSuffixPool, craftingMethod === "fossil");

  const totalPrefixWeight = modifiedPrefixes.reduce((sum, mod) => sum + mod.currentWeight, 0);
  const totalSuffixWeight = modifiedSuffixes.reduce((sum, mod) => sum + mod.currentWeight, 0);

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
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              borderRadius: hasActiveTarget || expandedGroups[groupName] ? "4px 4px 0 0" : "4px",
              border: hasActiveTarget ? "1px solid #4CAF50" : "1px solid transparent",
            }}
          >
            <span style={{ color: hasActiveTarget ? "#4CAF50" : "#ccc", fontSize: "14px" }}>
              {groupName}
            </span>
            <span style={{ color: "#888", fontSize: "12px" }}>{expandedGroups[groupName] ? "▲" : "▼"}</span>
          </div>

          {expandedGroups[groupName] && (
            <div style={{ border: "1px solid #555", borderTop: "none", background: "#1e1e1e", borderRadius: "0 0 4px 4px" }}>
              {mods.map((mod) => {
                const modifiedMod = modifiedPool.find((m) => m.id === mod.id);
                const currentWeight = modifiedMod?.currentWeight ?? mod.spawn_weights[0]?.weight ?? 0;
                const totalWeight = pool === currentPrefixPool ? totalPrefixWeight : totalSuffixWeight;
                const weightPct = totalWeight > 0 ? ((currentWeight / totalWeight) * 100).toFixed(2) : "0.00";
                const isTarget = targetIds.includes(mod.id);
                const isGuaranteed = mod.id === guaranteedModId;
                const isFractured = mod.id === fracturedModId;

                return (
                  <div
                    key={mod.id}
                    onClick={() => !isGuaranteed && !isFractured && toggleTarget(mod.id, groupName)}
                    style={{
                      padding: "8px 12px",
                      background: isTarget ? "#1a3a1a" : isGuaranteed ? "#1a1030" : isFractured ? "#2a1a00" : "transparent",
                      borderBottom: "1px solid #333",
                      cursor: isGuaranteed || isFractured ? "default" : "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      opacity: currentWeight === 0 && !isGuaranteed ? 0.4 : 1,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{
                          color: isTarget ? "#4CAF50" : isGuaranteed ? "#c77be3" : isFractured ? "#e2b659" : "#ddd",
                          fontSize: "13px",
                        }}>
                          {mod.tier != null && <span style={{ color: "#888", marginRight: "4px" }}>T{mod.tier}</span>}
                          {mod.text}
                        </span>
                        {isGuaranteed && (
                          <span style={{ fontSize: "10px", background: "#c77be3", color: "#000", padding: "1px 5px", borderRadius: "2px", fontWeight: "bold" }}>
                            GUARANTEED
                          </span>
                        )}
                        {isFractured && (
                          <span style={{ fontSize: "10px", background: "#e2b659", color: "#000", padding: "1px 5px", borderRadius: "2px", fontWeight: "bold" }}>
                            FRACTURED
                          </span>
                        )}
                      </div>
                    </div>
                    <span style={{ color: "#888", fontSize: "12px", marginLeft: "8px", whiteSpace: "nowrap" }}>
                      {weightPct}%
                    </span>
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

        const swapGroup = ELEMENTAL_RESIST_GROUPS.has(targetMod.group) ? ELEMENTAL_RESIST_GROUPS : null;
        modifiedPool.forEach((mod) => {
          const groupMatches = swapGroup ? swapGroup.has(mod.group) : mod.group === targetMod.group;
          if (!groupMatches) return;
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
    <div style={{ background: "#2d2d2d", padding: "20px", borderRadius: "8px" }}>
      {/* Base selection */}
      <div style={{ marginBottom: "20px", paddingBottom: "15px", borderBottom: "1px solid #444" }}>
        <label style={{ display: "block", fontWeight: "bold", color: "#fff", fontSize: "16px", marginBottom: "8px" }}>
          Select Item Base:
        </label>
        <select
          value={selectedItemClass}
          onChange={(e) => setSelectedItemClass(e.target.value)}
          style={{ width: "100%", padding: "12px", background: "#111", color: "white", border: "1px solid #6bbbe3", fontSize: "16px", fontWeight: "bold" }}
        >
          <option value="ring">Ring</option>
          <option value="amulet">Amulet</option>
          <option value="belt">Belt</option>
          <option value="body_armour">Body Armour</option>
          <option value="helmet">Helmet</option>
          <option value="boots">Boots</option>
          <option value="gloves">Gloves</option>
        </select>

        <label style={{ display: "block", fontWeight: "bold", color: "#fff", fontSize: "14px", marginTop: "12px", marginBottom: "6px" }}>
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
              borderRadius: "4px", cursor: "pointer", fontSize: "13px",
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
                borderRadius: "4px", cursor: "pointer", fontSize: "13px",
                fontWeight: selectedInfluence === id ? "bold" : "normal",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <label style={{ display: "block", fontWeight: "bold", color: "#fff", fontSize: "14px", marginTop: "12px", marginBottom: "6px" }}>
          Item Level:
        </label>
        <input
          type="number"
          min={1}
          max={100}
          value={itemLevel}
          onChange={(e) => {
            const v = Math.max(1, Math.min(100, Number(e.target.value) || 1));
            setItemLevel(v);
            setTargetIds([]);
            setResult(null);
          }}
          style={{ width: "80px", padding: "6px 10px", background: "#1e1e1e", color: "white", border: "1px solid #6bbbe3", fontSize: "14px", fontWeight: "bold" }}
        />
      </div>

      {/* Cost inputs */}
      <div style={{ display: "flex", gap: "15px", marginBottom: "15px" }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: "block", fontSize: "14px", color: "#aaa" }}>Base Cost (Chaos)</label>
          <input
            type="number"
            value={baseCostChaos}
            onChange={(e) => setBaseCostChaos(Number(e.target.value))}
            style={{ width: "100%", padding: "8px", background: "#1e1e1e", color: "white", border: "1px solid #555" }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: "block", fontSize: "14px", color: "#aaa" }}>Sell Value (Divines)</label>
          <input
            type="number"
            value={marketValueDivines}
            onChange={(e) => setMarketValueDivines(Number(e.target.value))}
            style={{ width: "100%", padding: "8px", background: "#1e1e1e", color: "white", border: "1px solid #555" }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: "block", fontWeight: "bold", color: "#e2b659", fontSize: "14px" }}>Fractured Mod:</label>
          <select
            value={fracturedModId}
            onChange={(e) => setFracturedModId(e.target.value)}
            style={{ width: "100%", padding: "8px", background: "#1e1e1e", color: "white", border: "1px solid #555" }}
          >
            <option value="none">None / Normal Base</option>
            <optgroup label="Prefixes">
              {currentPrefixPool.map((m) => (
                <option key={m.id} value={m.id} disabled={m.id === guaranteedModId}>{m.text}</option>
              ))}
            </optgroup>
            <optgroup label="Suffixes">
              {currentSuffixPool.map((m) => (
                <option key={m.id} value={m.id} disabled={m.id === guaranteedModId}>{m.text}</option>
              ))}
            </optgroup>
          </select>
        </div>
      </div>

      {/* Crafting method */}
      <div style={{ marginBottom: "20px", paddingBottom: "20px", borderBottom: "1px solid #444" }}>
        <h3 style={{ marginTop: 0 }}>Crafting Method</h3>
        <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
          {[
            { id: "essence", label: "Essences",  color: "#c77be3" },
            { id: "fossil",  label: "Fossils",   color: "#e2b659" },
            { id: "chaos",   label: "Chaos Orb", color: "#6bbbe3" },
          ].map(({ id, label, color }) => (
            <button
              key={id}
              onClick={() => setCraftingMethod(id)}
              style={{
                flex: 1, padding: "10px",
                background: craftingMethod === id ? color : "#333",
                color: craftingMethod === id ? "#000" : "#fff",
                border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {craftingMethod === "essence" && (
          <select
            value={selectedEssenceId}
            onChange={(e) => setSelectedEssenceId(e.target.value)}
            style={{ width: "100%", padding: "10px", background: "#1e1e1e", color: "white", border: "1px solid #c77be3" }}
          >
            {Object.entries(essenceDataList).map(([key, data]) => (
              <option key={key} value={key}>
                {data.name} ({(economyData.essences && economyData.essences[key]) || 3}c)
              </option>
            ))}
          </select>
        )}

        {craftingMethod === "fossil" && (
          <div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {Object.entries(fossilData).map(([fossilId, data]) => {
                const fossilCost = (economyData.fossils && economyData.fossils[fossilId]) || 1;
                return (
                  <button
                    key={fossilId}
                    onClick={() => toggleFossil(fossilId)}
                    style={{
                      padding: "10px 15px",
                      background: activeFossils.includes(fossilId) ? "#e2b659" : "#1e1e1e",
                      color: activeFossils.includes(fossilId) ? "#000" : "#aaa",
                      border: "1px solid #e2b659", borderRadius: "4px",
                      cursor: activeFossils.length >= 4 && !activeFossils.includes(fossilId) ? "not-allowed" : "pointer",
                      opacity: activeFossils.length >= 4 && !activeFossils.includes(fossilId) ? 0.5 : 1,
                    }}
                  >
                    {data.name} ({fossilCost}c)
                  </button>
                );
              })}
            </div>
            {activeFossils.length > 0 && (() => {
              const resonatorNames = [null, "Primitive Chaotic Resonator", "Potent Chaotic Resonator", "Powerful Chaotic Resonator", "Prime Chaotic Resonator"];
              const resonatorKeys = [null, "primitive_chaotic_resonator", "potent_chaotic_resonator", "powerful_chaotic_resonator", "prime_chaotic_resonator"];
              const name = resonatorNames[activeFossils.length];
              const key  = resonatorKeys[activeFossils.length];
              const cost = key ? (economyData.resonators?.[key] ?? 2) : 2;
              return (
                <div style={{ marginTop: "8px", color: "#e2b659", fontSize: "13px" }}>
                  Resonator: <strong>{name}</strong> ({cost}c)
                </div>
              );
            })()}
          </div>
        )}
      </div>

      <button
        onClick={handleCalculate}
        style={{
          width: "100%", padding: "15px", fontSize: "18px",
          background: "#4CAF50", color: "white", border: "none",
          borderRadius: "4px", cursor: "pointer", fontWeight: "bold", marginBottom: "16px",
        }}
      >
        Calculate Final Result
      </button>

      {result && !result.error && (
        <div style={{ marginBottom: "20px", padding: "20px", border: "1px solid #555", background: "#111" }}>
          <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #333", paddingBottom: "10px", marginBottom: "10px" }}>
            <span style={{ color: "#aaa", fontWeight: "bold" }}>FINAL CALCULATION:</span>
            <strong style={{ fontSize: "18px", color: "#e2b659" }}>
              {result.probability} (~{result.averageTries} tries)
            </strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: "5px" }}>
            <span style={{ color: "#aaa" }}>Base Item Cost:</span>
            <span>{baseCostChaos}c</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: "10px", borderBottom: "1px solid #333", marginBottom: "10px" }}>
            <span style={{ color: "#aaa" }}>Crafting Cost:</span>
            <span>{result.expectedCostChaos}c</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "18px", fontWeight: "bold", borderTop: "2px solid #555", paddingTop: "15px" }}>
            <span>Expected Profit:</span>
            <span style={{ color: marketValueDivines * divinePrice - (baseCostChaos + result.expectedCostChaos) > 0 ? "#4CAF50" : "#ff6666" }}>
              {Math.round(marketValueDivines * divinePrice - (baseCostChaos + result.expectedCostChaos))} Chaos
            </span>
          </div>
        </div>
      )}

      {result?.error && (
        <div style={{ marginBottom: "20px", padding: "15px", border: "1px solid #ff6666", background: "#2a0000", color: "#ff6666" }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      <h3 style={{ marginTop: 0 }}>Select Targets</h3>
      <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ borderBottom: "1px solid #555", paddingBottom: "5px", marginBottom: "10px", fontWeight: "bold", color: "#6bbbe3" }}>
            Prefixes (Total Weight: {totalPrefixWeight})
          </div>
          <div style={{ paddingRight: "5px", display: "flex", flexDirection: "column", gap: "5px" }}>
            {renderGroupedList(currentPrefixPool, modifiedPrefixes)}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ borderBottom: "1px solid #555", paddingBottom: "5px", marginBottom: "10px", fontWeight: "bold", color: "#6bbbe3" }}>
            Suffixes (Total Weight: {totalSuffixWeight})
          </div>
          <div style={{ paddingRight: "5px", display: "flex", flexDirection: "column", gap: "5px" }}>
            {renderGroupedList(currentSuffixPool, modifiedSuffixes)}
          </div>
        </div>
      </div>

      {targetStats.length > 0 && (
        <div style={{ marginBottom: "20px", background: "#1a1a1a", border: "1px solid #444", borderRadius: "4px", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", textAlign: "left" }}>
            <thead>
              <tr style={{ background: "#333", color: "#aaa" }}>
                {["AFFIXES", "Type", "Tier", "Tiers", "Weight", "Weight %"].map((h) => (
                  <th key={h} style={{ padding: "10px", borderBottom: "1px solid #444" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {targetStats.map((stat, idx) => (
                <tr key={stat.id} style={{ borderBottom: "1px solid #333", background: idx % 2 === 0 ? "#1e1e1e" : "#1a1a1a" }}>
                  <td style={{ padding: "10px", color: stat.type === "Prefix" ? "#c77be3" : "#6bbbe3" }}>{stat.group}</td>
                  <td style={{ padding: "10px" }}>{stat.type}</td>
                  <td style={{ padding: "10px" }}>{stat.tierString}</td>
                  <td style={{ padding: "10px" }}>{stat.tiersCount}</td>
                  <td style={{ padding: "10px", color: "#e2b659" }}>{stat.weight}</td>
                  <td style={{ padding: "10px" }}>{stat.weightPercent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
