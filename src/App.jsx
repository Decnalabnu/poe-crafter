import { useState, useEffect } from "react";
import ringsData from "./data/rings.json";
import mockData from "./data/mockData.json";
import { calculateSpamEV } from "./utils/calculator";

function App() {
  // Crafting State
  const [selectedEssenceId, setSelectedEssenceId] = useState(
    "deafening_essence_of_spite",
  );
  const [target1Id, setTarget1Id] = useState("life_tier_1");
  const [target2Id, setTarget2Id] = useState("any"); // Default to Any Mod
  const [result, setResult] = useState(null);

  // Economy Input State
  const [baseCostChaos, setBaseCostChaos] = useState(50);
  const [marketValueDivines, setMarketValueDivines] = useState(10);

  const essenceData = mockData.essences[selectedEssenceId];
  const guaranteedModId = essenceData.guaranteed_mod;
  const divinePrice = mockData.basic_currency.divine_orb.cost;

  // Prevent selecting the guaranteed mod
  useEffect(() => {
    if (target1Id === guaranteedModId) setTarget1Id("any");
    if (target2Id === guaranteedModId) setTarget2Id("any");
  }, [guaranteedModId, target1Id, target2Id]);

  const handleCalculate = () => {
    const evData = calculateSpamEV(target1Id, target2Id, selectedEssenceId);
    setResult(evData);
  };

  const renderOptions = (pool, currentSelection, otherDropdownSelection) => {
    return pool.map((mod) => {
      const isJunk = mod.id.startsWith("junk_");
      if (isJunk) return null;

      // If the other dropdown has this mod selected (and it's not 'any'), disable it here
      const isDisabled =
        mod.id === guaranteedModId ||
        (mod.id === otherDropdownSelection && mod.id !== "any");
      return (
        <option key={mod.id} value={mod.id} disabled={isDisabled}>
          {mod.text} {isDisabled && "(Unavailable)"}
        </option>
      );
    });
  };

  return (
    <div
      style={{
        padding: "20px",
        fontFamily: "sans-serif",
        maxWidth: "650px",
        margin: "0 auto",
      }}
    >
      <h1>PoE Profit Crafter (MVP)</h1>

      <div
        style={{
          background: "#2d2d2d",
          color: "white",
          padding: "20px",
          borderRadius: "8px",
        }}
      >
        {/* ECONOMY INPUTS */}
        <div
          style={{
            display: "flex",
            gap: "15px",
            marginBottom: "20px",
            paddingBottom: "20px",
            borderBottom: "1px solid #555",
          }}
        >
          <div style={{ flex: 1 }}>
            <label
              style={{
                display: "block",
                marginBottom: "5px",
                fontSize: "14px",
                color: "#aaa",
              }}
            >
              Base Item Cost (Chaos)
            </label>
            <input
              type="number"
              value={baseCostChaos}
              onChange={(e) => setBaseCostChaos(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "4px",
                backgroundColor: "#1e1e1e",
                color: "white",
                border: "1px solid #555",
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label
              style={{
                display: "block",
                marginBottom: "5px",
                fontSize: "14px",
                color: "#aaa",
              }}
            >
              Finished Value (Divines)
            </label>
            <input
              type="number"
              value={marketValueDivines}
              onChange={(e) => setMarketValueDivines(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "4px",
                backgroundColor: "#1e1e1e",
                color: "white",
                border: "1px solid #555",
              }}
            />
          </div>
        </div>

        {/* CRAFTING INPUTS */}
        <div style={{ marginBottom: "15px" }}>
          <label
            style={{
              display: "block",
              marginBottom: "8px",
              fontWeight: "bold",
            }}
          >
            Select Essence:
          </label>
          <select
            value={selectedEssenceId}
            onChange={(e) => setSelectedEssenceId(e.target.value)}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: "4px",
              backgroundColor: "#1e1e1e",
              color: "white",
              border: "1px solid #555",
            }}
          >
            {Object.entries(mockData.essences).map(([key, data]) => (
              <option key={key} value={key}>
                {data.name} ({data.cost}c)
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: "15px" }}>
          <label
            style={{
              display: "block",
              marginBottom: "8px",
              fontWeight: "bold",
            }}
          >
            Target Mod 1:
          </label>
          <select
            value={target1Id}
            onChange={(e) => setTarget1Id(e.target.value)}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: "4px",
              backgroundColor: "#1e1e1e",
              color: "white",
              border: "1px solid #555",
            }}
          >
            <option value="any">None / Any Mod</option>
            <optgroup label="Prefixes">
              {renderOptions(ringsData.prefixes, target1Id, target2Id)}
            </optgroup>
            <optgroup label="Suffixes">
              {renderOptions(ringsData.suffixes, target1Id, target2Id)}
            </optgroup>
          </select>
        </div>

        <div style={{ marginBottom: "20px" }}>
          <label
            style={{
              display: "block",
              marginBottom: "8px",
              fontWeight: "bold",
            }}
          >
            Target Mod 2:
          </label>
          <select
            value={target2Id}
            onChange={(e) => setTarget2Id(e.target.value)}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: "4px",
              backgroundColor: "#1e1e1e",
              color: "white",
              border: "1px solid #555",
            }}
          >
            <option value="any">None / Any Mod</option>
            <optgroup label="Prefixes">
              {renderOptions(ringsData.prefixes, target2Id, target1Id)}
            </optgroup>
            <optgroup label="Suffixes">
              {renderOptions(ringsData.suffixes, target2Id, target1Id)}
            </optgroup>
          </select>
        </div>

        <button
          onClick={handleCalculate}
          style={{
            width: "100%",
            padding: "15px",
            fontSize: "18px",
            cursor: "pointer",
            backgroundColor: "#4CAF50",
            color: "white",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold",
          }}
        >
          Calculate Profit Margin
        </button>

        {/* PROFIT RESULTS */}
        {result && !result.error && (
          <div
            style={{
              marginTop: "20px",
              padding: "20px",
              border: "1px solid #555",
              borderRadius: "4px",
              backgroundColor: "#1a1a1a",
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
              <span>Hit Probability:</span>
              <strong>
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
              <span style={{ color: "#aaa" }}>Crafting Cost (Essences):</span>
              <span>{result.expectedCostChaos}c</span>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "18px",
                fontWeight: "bold",
                marginBottom: "20px",
              }}
            >
              <span>Total Project Cost:</span>
              <span style={{ color: "#ff6666" }}>
                {baseCostChaos + result.expectedCostChaos}c
              </span>
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
              borderRadius: "4px",
              backgroundColor: "#2a0000",
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
