import { useState, useEffect } from "react";
import itemsData from "../data/items.json";
import { useEconomy } from "../contexts/EconomyContext";
import { calculateRecombEV } from "../utils/calculator";
import { INFLUENCES } from "../constants";

const ITEM_CLASSES = [
  { value: "ring",        label: "Ring" },
  { value: "amulet",      label: "Amulet" },
  { value: "belt",        label: "Belt" },
  { value: "body_armour", label: "Body Armour" },
  { value: "helmet",      label: "Helmet" },
  { value: "boots",       label: "Boots" },
  { value: "gloves",      label: "Gloves" },
];

export default function RecombCalculator() {
  const economyData = useEconomy();
  const [itemClass, setItemClass] = useState("ring");
  const [influence, setInfluence] = useState(null);
  const [affinityType, setAffinityType] = useState("prefix"); // "prefix" | "suffix"
  const [selectedIds, setSelectedIds] = useState([null, null, null]); // [A, B, C]
  const liveAltPrice = economyData.currency?.alteration ?? 0.15;
  const [altCost, setAltCost] = useState(liveAltPrice);
  const [recombCost, setRecombCost] = useState(100);
  const [sellValueDivines, setSellValueDivines] = useState(10);
  const [result, setResult] = useState(null);

  // Sync the alt-cost input with live economy once it loads (initial state is
  // seeded from the bundled snapshot, which may be stale until /active_economy.json
  // resolves).
  useEffect(() => {
    setAltCost(liveAltPrice);
  }, [liveAltPrice]);

  const divinePrice = economyData.divine_price || 150;

  const pool = itemsData[itemClass];
  const influenceFilter = (m) => !m.influence || m.influence === influence;
  const modPool = pool
    ? (affinityType === "prefix" ? pool.prefixes : pool.suffixes)
        .filter(influenceFilter)
        .filter((m) => (m.spawn_weights?.[0]?.weight || 0) > 0 && !m.id.startsWith("junk_"))
    : [];

  const t1Mods = modPool.filter((m) => m.tier === 1);

  const handleSelectMod = (slotIdx, modId) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      next[slotIdx] = modId === prev[slotIdx] ? null : modId;
      return next;
    });
    setResult(null);
  };

  const handleCalculate = () => {
    const ids = selectedIds;
    if (ids.some((id) => !id)) {
      setResult({ error: "Select a mod for each of the three slots (A, B, C)." });
      return;
    }
    const r = calculateRecombEV({
      itemClass,
      modIds: ids,
      recombCostChaos: recombCost,
      altCostChaos: altCost,
      influence,
    });
    setResult(r);
  };

  const slotLabels = ["A", "B (overlap)", "C"];
  const slotColors = ["#6bbbe3", "#e2b659", "#c77be3"];

  const profitChaos = result && !result.error
    ? Math.round(sellValueDivines * divinePrice - result.totalCostChaos)
    : null;

  return (
    <div style={{ background: "#2d2d2d", padding: "20px", borderRadius: "8px" }}>
      <div style={{ marginBottom: "16px", color: "#aaa", fontSize: "13px", lineHeight: "1.6" }}>
        Select three T1 affixes of the same type. <strong style={{ color: "#e2b659" }}>B is the overlap mod</strong> — it appears on both 2-mod intermediates (AB and BC), giving it a double-ticket advantage in the final merge.
      </div>

      {/* Item class + influence */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px" }}>
          <label style={{ display: "block", fontSize: "12px", color: "#888", marginBottom: "4px" }}>Item Class</label>
          <select
            value={itemClass}
            onChange={(e) => { setItemClass(e.target.value); setSelectedIds([null, null, null]); setResult(null); }}
            style={{ width: "100%", padding: "7px 10px", background: "#1e1e1e", color: "white", border: "1px solid #555", borderRadius: "4px", fontSize: "13px" }}
          >
            {ITEM_CLASSES.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        <div style={{ flex: "1 1 160px" }}>
          <label style={{ display: "block", fontSize: "12px", color: "#888", marginBottom: "4px" }}>Affix Type</label>
          <div style={{ display: "flex", gap: "6px" }}>
            {["prefix", "suffix"].map((type) => (
              <button
                key={type}
                onClick={() => { setAffinityType(type); setSelectedIds([null, null, null]); setResult(null); }}
                style={{
                  flex: 1, padding: "7px", fontSize: "13px",
                  background: affinityType === type ? (type === "prefix" ? "#c77be333" : "#6bbbe333") : "#1e1e1e",
                  color: affinityType === type ? (type === "prefix" ? "#c77be3" : "#6bbbe3") : "#888",
                  border: `1px solid ${affinityType === type ? (type === "prefix" ? "#c77be3" : "#6bbbe3") : "#444"}`,
                  borderRadius: "4px", cursor: "pointer", fontWeight: "bold", textTransform: "capitalize",
                }}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: "1 1 200px" }}>
          <label style={{ display: "block", fontSize: "12px", color: "#888", marginBottom: "4px" }}>Influence</label>
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            <button
              onClick={() => { setInfluence(null); setSelectedIds([null, null, null]); setResult(null); }}
              style={{
                padding: "4px 10px", fontSize: "12px",
                background: influence === null ? "#333" : "#1a1a1a",
                color: influence === null ? "#fff" : "#555",
                border: `1px solid ${influence === null ? "#666" : "#333"}`,
                borderRadius: "3px", cursor: "pointer",
              }}
            >
              None
            </button>
            {INFLUENCES.map(({ id, label, color }) => (
              <button
                key={id}
                onClick={() => { setInfluence(influence === id ? null : id); setSelectedIds([null, null, null]); setResult(null); }}
                style={{
                  padding: "4px 10px", fontSize: "12px",
                  background: influence === id ? color + "22" : "#1a1a1a",
                  color: influence === id ? color : "#555",
                  border: `1px solid ${influence === id ? color : "#333"}`,
                  borderRadius: "3px", cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Costs */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        {[
          { label: "Alt cost (c)", value: altCost, setter: setAltCost, step: 0.01 },
          { label: "Recomb cost (c)", value: recombCost, setter: setRecombCost, step: 1 },
          { label: "Sell value (div)", value: sellValueDivines, setter: setSellValueDivines, step: 1 },
        ].map(({ label, value, setter, step }) => (
          <div key={label} style={{ flex: "1 1 120px" }}>
            <label style={{ display: "block", fontSize: "12px", color: "#888", marginBottom: "4px" }}>{label}</label>
            <input
              type="number"
              min={0}
              step={step}
              value={value}
              onChange={(e) => setter(Number(e.target.value))}
              style={{ width: "100%", padding: "7px 10px", background: "#1e1e1e", color: "white", border: "1px solid #555", borderRadius: "4px", fontSize: "13px" }}
            />
          </div>
        ))}
      </div>

      {/* Mod selection */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", color: "#555", letterSpacing: "0.05em", marginBottom: "10px" }}>
          SELECT THREE T1 {affinityType.toUpperCase()}ES
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          {[0, 1, 2].map((slotIdx) => (
            <div key={slotIdx} style={{ flex: 1 }}>
              <div style={{ fontSize: "12px", color: slotColors[slotIdx], marginBottom: "6px", fontWeight: "bold" }}>
                Mod {slotLabels[slotIdx]}
              </div>
              <select
                value={selectedIds[slotIdx] ?? ""}
                onChange={(e) => handleSelectMod(slotIdx, e.target.value || null)}
                style={{
                  width: "100%", padding: "7px 10px", background: "#1e1e1e", color: "white",
                  border: `1px solid ${selectedIds[slotIdx] ? slotColors[slotIdx] : "#444"}`,
                  borderRadius: "4px", fontSize: "12px",
                }}
              >
                <option value="">— select —</option>
                {t1Mods.map((m) => (
                  <option key={m.id} value={m.id} disabled={selectedIds.includes(m.id) && selectedIds[slotIdx] !== m.id}>
                    {m.group} (T{m.tier})
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {t1Mods.length === 0 && (
          <div style={{ color: "#555", fontSize: "12px", marginTop: "8px" }}>
            No T1 {affinityType}es available for this item class / influence combination.
          </div>
        )}
      </div>

      <button
        onClick={handleCalculate}
        disabled={selectedIds.some((id) => !id)}
        style={{
          width: "100%", padding: "12px", fontSize: "15px",
          background: selectedIds.some((id) => !id) ? "#1a3a1a" : "#4CAF50",
          color: selectedIds.some((id) => !id) ? "#3a5a3a" : "#000",
          border: "none", borderRadius: "4px", cursor: selectedIds.some((id) => !id) ? "default" : "pointer",
          fontWeight: "bold", marginBottom: "16px",
          transition: "background 0.15s",
        }}
      >
        Calculate Expected Cost
      </button>

      {result?.error && (
        <div style={{ padding: "12px", border: "1px solid #ff6666", background: "#2a0000", color: "#ff6666", borderRadius: "4px", marginBottom: "12px" }}>
          <strong>Error:</strong> {result.error}
        </div>
      )}

      {result && !result.error && (
        <div style={{ background: "#111", border: "1px solid #444", borderRadius: "6px", overflow: "hidden" }}>
          {/* Phase 1 */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #333" }}>
            <div style={{ color: "#6bbbe3", fontWeight: "bold", fontSize: "13px", marginBottom: "8px", letterSpacing: "0.05em" }}>
              PHASE 1 — ALT-ROLL SINGLE MODS
            </div>
            {result.phase1.details.map((d, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "4px" }}>
                <span style={{ color: slotColors[i] }}>Mod {slotLabels[i]}: {d.group} T{d.tier}</span>
                <span style={{ color: "#aaa" }}>
                  {d.weightPct}% pool · ~{d.expectedAlts} alts ·{" "}
                  <span style={{ color: "#e2b659" }}>{Math.round(d.altCost)}c</span>
                </span>
              </div>
            ))}
          </div>

          {/* Phase 2 */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #333" }}>
            <div style={{ color: "#e2b659", fontWeight: "bold", fontSize: "13px", marginBottom: "8px", letterSpacing: "0.05em" }}>
              PHASE 2 — BUILD 2-MOD PAIRS (AB + BC)
            </div>
            <div style={{ display: "flex", gap: "24px", fontSize: "13px", flexWrap: "wrap" }}>
              <div><span style={{ color: "#888" }}>Pool size:</span> <span style={{ color: "#ddd" }}>2 mods</span></div>
              <div><span style={{ color: "#888" }}>P(keep both):</span> <span style={{ color: "#4CAF50" }}>{result.phase2.pSuccess}%</span></div>
              <div><span style={{ color: "#888" }}>Expected attempts per pair:</span> <span style={{ color: "#ddd" }}>~{result.phase2.expectedAttempts}</span></div>
            </div>
            <div style={{ marginTop: "6px", display: "flex", gap: "24px", fontSize: "13px", flexWrap: "wrap" }}>
              <div><span style={{ color: "#888" }}>Cost for AB item:</span> <span style={{ color: "#e2b659" }}>{Math.round(result.phase2.costPerAB)}c</span></div>
              <div><span style={{ color: "#888" }}>Cost for BC item:</span> <span style={{ color: "#e2b659" }}>{Math.round(result.phase2.costPerBC)}c</span></div>
            </div>
          </div>

          {/* Phase 3 */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid #333" }}>
            <div style={{ color: "#c77be3", fontWeight: "bold", fontSize: "13px", marginBottom: "8px", letterSpacing: "0.05em" }}>
              PHASE 3 — FINAL MERGE (AB + BC → ABC)
            </div>
            <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>
              Pool = &#123;A, B, B, C&#125; — B has double-ticket (appears on both inputs)
            </div>
            <div style={{ display: "flex", gap: "24px", fontSize: "13px", flexWrap: "wrap" }}>
              <div><span style={{ color: "#888" }}>P(keep 3 of 4):</span> <span style={{ color: "#ddd" }}>25%</span></div>
              <div><span style={{ color: "#888" }}>P(correct 3 | keep 3):</span> <span style={{ color: "#ddd" }}>50%</span></div>
              <div><span style={{ color: "#888" }}>Combined P(success):</span> <span style={{ color: "#4CAF50" }}>{result.phase3.pSuccess}%</span></div>
              <div><span style={{ color: "#888" }}>Expected attempts:</span> <span style={{ color: "#ddd" }}>~{result.phase3.expectedAttempts}</span></div>
            </div>
          </div>

          {/* Totals */}
          <div style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", marginBottom: "6px" }}>
              <span style={{ color: "#aaa" }}>Total Expected Cost</span>
              <span style={{ color: "#e2b659", fontWeight: "bold" }}>
                {Math.round(result.totalCostChaos)}c ≈ {result.totalCostDivines.toFixed(1)} div
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", marginBottom: "6px" }}>
              <span style={{ color: "#aaa" }}>Sell Value</span>
              <span style={{ color: "#ddd" }}>{sellValueDivines} div ≈ {Math.round(sellValueDivines * divinePrice)}c</span>
            </div>
            <div style={{
              display: "flex", justifyContent: "space-between", fontSize: "18px", fontWeight: "bold",
              borderTop: "2px solid #333", paddingTop: "12px", marginTop: "8px",
            }}>
              <span>Expected Profit</span>
              <span style={{ color: profitChaos >= 0 ? "#4CAF50" : "#ff6666" }}>
                {profitChaos >= 0 ? "+" : ""}{profitChaos}c ≈ {(profitChaos / divinePrice).toFixed(1)} div
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
