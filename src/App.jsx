import { useState, useEffect } from "react";
import itemsData from "./data/items.json";
import BuildAnalyzer from "./components/BuildAnalyzer";
import RecombCalculator from "./components/RecombCalculator";
import CrafterTab from "./components/CrafterTab";
import CraftOptimizer from "./components/CraftOptimizer";
import ProfitHeatmap from "./components/ProfitHeatmap";
import ScryingRanker from "./components/ScryingRanker";
import { ELEMENTAL_RESIST_GROUPS } from "./constants";

const TABS = [
  { id: "heatmap", label: "Profit Heatmap" },
  { id: "crafter", label: "Crafter" },
  { id: "route",   label: "Craft Optimizer" },
  { id: "builds",  label: "Build Analyzer" },
  { id: "recomb",  label: "Recomb Calculator" },
  { id: "scrying", label: "Scrying Ranker" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("crafter");

  // craftInit + craftInitKey: used by BuildAnalyzer's "Craft this slot" button
  // to push a starting state into CrafterTab without lifting all crafter state.
  const [craftInit, setCraftInit]       = useState(null);
  const [craftInitKey, setCraftInitKey] = useState(0);

  useEffect(() => {
    document.body.style.backgroundColor = "#0f172a";
    document.body.style.color = "#e2e8f0";
    document.body.style.margin = "0";
  }, []);

  const handleCraftThis = (slotKey, rawModFrequency) => {
    // Take ≥40% groups (core + common), sorted by frequency desc
    const topGroups = Object.entries(rawModFrequency)
      .filter(([, stats]) => stats.frequency_pct >= 40)
      .sort((a, b) => b[1].frequency_pct - a[1].frequency_pct)
      .map(([group]) => group);

    // Collapse elemental resists: only the highest-frequency one (harvest-swappable)
    let resistAdded = false;
    const deduped = [];
    for (const group of topGroups) {
      if (ELEMENTAL_RESIST_GROUPS.has(group)) {
        if (!resistAdded) { deduped.push(group); resistAdded = true; }
      } else {
        deduped.push(group);
      }
    }

    const pool = itemsData[slotKey];
    if (!pool) return;
    const allMods = [...pool.prefixes, ...pool.suffixes];

    const resolved = [];
    for (const group of deduped) {
      const best = allMods
        .filter(m => m.group === group && (m.spawn_weights?.[0]?.weight ?? 0) > 0)
        .sort((a, b) => (a.tier ?? 999) - (b.tier ?? 999))[0];
      if (best) resolved.push(best);
    }

    // Detect influence: single influence → use it; mixed → drop influenced mods
    const influences = new Set(resolved.filter(m => m.influence).map(m => m.influence));
    let influence = null;
    let finalMods = resolved;
    if (influences.size === 1) {
      influence = [...influences][0];
    } else if (influences.size > 1) {
      finalMods = resolved.filter(m => !m.influence);
    }

    setCraftInit({ itemClass: slotKey, influence, targetIds: finalMods.map(m => m.id) });
    setCraftInitKey(k => k + 1);
    setActiveTab("crafter");
  };

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif", maxWidth: "1000px", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "16px", color: "#f8fafc" }}>PoE Profit Crafter</h1>

      {/* Tab strip */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "8px 18px",
              background: activeTab === tab.id ? "#4CAF50" : "#2d2d2d",
              color:      activeTab === tab.id ? "#000"    : "#aaa",
              border:     activeTab === tab.id ? "none"    : "1px solid #444",
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

      {activeTab === "heatmap"  && <ProfitHeatmap />}
      {activeTab === "crafter"  && <CrafterTab craftInit={craftInit} craftInitKey={craftInitKey} />}
      {activeTab === "route"    && <CraftOptimizer />}
      {activeTab === "builds"   && <BuildAnalyzer onCraftThis={handleCraftThis} />}
      {activeTab === "recomb"   && <RecombCalculator />}
      {activeTab === "scrying"  && <ScryingRanker />}
    </div>
  );
}
