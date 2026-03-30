import { useState, useEffect } from "react";
import ringsData from "./data/rings.json";
import mockData from "./data/active_economy.json";
import fossilData from "./data/fossils.json";
import { calculateSpamEV } from "./utils/calculator";

function App() {
  const [craftingMethod, setCraftingMethod] = useState("essence"); // 'essence' or 'fossil'
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

  const essenceData = mockData.essences[selectedEssenceId];
  const guaranteedModId =
    craftingMethod === "essence" ? essenceData?.guaranteed_mod : null;
  const divinePrice = mockData.basic_currency.divine_orb.cost;

  // Cleanup effect
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
      "ring",
      fracturedModId,
      fossilsToPass,
    );
    setResult(evData);
  };

  const toggleTarget = (modId) => {
    setTargetIds((prev) =>
      prev.includes(modId)
        ? prev.filter((id) => id !== modId)
        : [...prev, modId],
    );
  };

  const toggleGroup = (groupName) => {
    setExpandedGroups((prev) => ({ ...prev, [groupName]: !prev[groupName] }));
  };

  const toggleFossil = (fossilId) => {
    setActiveFossils((prev) => {
      if (prev.includes(fossilId)) return prev.filter((id) => id !== fossilId);
      if (prev.length >= 4) return prev; // Max 4 socket resonator
      return [...prev, fossilId];
    });
  };

  // --- DYNAMIC POOL CALCULATOR FOR THE UI TABLE ---
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
    ringsData.prefixes,
    craftingMethod === "fossil",
  );
  const modifiedSuffixes = getModifiedPool(
    ringsData.suffixes,
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

                let bg = "#1e1e1e";
                let cursor = "pointer";
                let label = mod.text;

                if (isEssence) {
                  bg = "#4a235a";
                  cursor = "not-allowed";
                  label += " (Essence)";
                } else if (isFracture) {
                  bg = "#5a4f23";
                  cursor = "not-allowed";
                  label += " (Fractured)";
                } else if (isZeroWeight) {
                  bg = "#3d1c1c";
                  cursor = "not-allowed";
                  label += " (0 Weight)";
                } else if (isTargeted) {
                  bg = "#4CAF50";
                  color: "#fff";
                }

                return (
                  <div
                    key={mod.id}
                    onClick={() => {
                      if (!isEssence && !isFracture && !isZeroWeight)
                        toggleTarget(mod.id);
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
                    {label}
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
        const match = tId.match(/(.+)_tier_(\d+)/);
        const tBase = match ? match[1] : tId;
        const tTier = match ? parseInt(match[2], 10) : 0;

        let isPrefix = true;
        let targetMod = ringsData.prefixes.find((m) => m.id === tId);
        if (!targetMod) {
          targetMod = ringsData.suffixes.find((m) => m.id === tId);
          isPrefix = false;
        }

        if (!targetMod) return null;

        const modifiedPool = isPrefix ? modifiedPrefixes : modifiedSuffixes;
        let combinedWeight = 0;
        let qualifyingTiers = 0;

        modifiedPool.forEach((mod) => {
          const rMatch = mod.id.match(/(.+)_tier_(\d+)/);
          if (match && rMatch && rMatch[1] === tBase) {
            const rTier = parseInt(rMatch[2], 10);
            if (rTier <= tTier && mod.currentWeight > 0) {
              combinedWeight += mod.currentWeight;
              qualifyingTiers++;
            }
          } else if (mod.id === tId && mod.currentWeight > 0) {
            combinedWeight += mod.currentWeight;
            qualifyingTiers = 1;
          }
        });

        const totalPoolWeight = isPrefix
          ? totalPrefixWeight
          : totalSuffixWeight;
        const weightPercent =
          totalPoolWeight > 0 ? (combinedWeight / totalPoolWeight) * 100 : 0;

        return {
          id: tId,
          group: targetMod.group,
          type: isPrefix ? "Prefix" : "Suffix",
          tierString: `<= ${tTier}`,
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
      <h1>PoE Profit Crafter</h1>

      <div
        style={{ background: "#2d2d2d", padding: "20px", borderRadius: "8px" }}
      >
        {/* ECONOMY & BASE SETUP */}
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
                {ringsData.prefixes.map(
                  (m) =>
                    !m.id.startsWith("junk_") && (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={m.id === guaranteedModId}
                      >
                        {m.text}
                      </option>
                    ),
                )}
              </optgroup>
              <optgroup label="Suffixes">
                {ringsData.suffixes.map(
                  (m) =>
                    !m.id.startsWith("junk_") && (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={m.id === guaranteedModId}
                      >
                        {m.text}
                      </option>
                    ),
                )}
              </optgroup>
            </select>
          </div>
        </div>

        {/* CRAFTING METHOD TOGGLE */}
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

          {/* ESSENCE CONTROLS */}
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
                {Object.entries(mockData.essences).map(([key, data]) => (
                  <option key={key} value={key}>
                    {data.name} ({data.cost}c)
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* FOSSIL CONTROLS */}
          {craftingMethod === "fossil" && (
            <div>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                {Object.entries(fossilData).map(([fossilId, data]) => (
                  <button
                    key={fossilId}
                    onClick={() => toggleFossil(fossilId)}
                    style={{
                      padding: "10px 15px",
                      background: activeFossils.includes(fossilId)
                        ? "#e2b659"
                        : "#1e1e1e",
                      color: activeFossils.includes(fossilId) ? "#000" : "#aaa",
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
                    {data.name}
                  </button>
                ))}
              </div>
              <div
                style={{ fontSize: "12px", color: "#aaa", marginTop: "8px" }}
              >
                Select up to 4 fossils.
              </div>
            </div>
          )}
        </div>

        {/* AFFIX PICKER */}
        <h3 style={{ marginTop: 0 }}>Select Targets</h3>
        <div style={{ display: "flex", gap: "20px", marginBottom: "20px" }}>
          {/* Prefix Column */}
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
              {renderGroupedList(ringsData.prefixes, modifiedPrefixes)}
            </div>
          </div>

          {/* Suffix Column */}
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
              {renderGroupedList(ringsData.suffixes, modifiedSuffixes)}
            </div>
          </div>
        </div>

        {/* COE STYLE STATS TABLE */}
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

        {/* RESULTS */}
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
      </div>
    </div>
  );
}

export default App;
