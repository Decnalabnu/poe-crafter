import React, { useMemo, useState } from "react";
import mapData from "../data/map_cards.json";
import economyData from "../data/div_cards_economy.json";
import activeEconomy from "../data/active_economy.json";

const SORT_OPTIONS = [
  { id: "ev",     label: "EV (desc)" },
  { id: "name",   label: "Map name" },
  { id: "weight", label: "Total weight" },
];

const SHOW_OPTIONS = [
  { id: 10,  label: "Top 10" },
  { id: 25,  label: "Top 25" },
  { id: 50,  label: "Top 50" },
  { id: 999, label: "All" },
];

function formatChaos(c, divine) {
  if (c == null || c === 0) return "0c";
  const d = divine || 150;
  if (Math.abs(c) >= d) return `${(c / d).toFixed(2)}d`;
  if (Math.abs(c) >= 10) return `${c.toFixed(0)}c`;
  return `${c.toFixed(2)}c`;
}

function evColor(ev) {
  if (ev >= 20)  return "#4ade80";
  if (ev >= 10)  return "#86efac";
  if (ev >= 4)   return "#bef264";
  if (ev >= 1)   return "#fde68a";
  if (ev >= 0.2) return "#cbd5e1";
  return "#64748b";
}

function cardValueColor(price) {
  if (price >= 100) return "#f59e0b";
  if (price >= 10)  return "#fbbf24";
  if (price >= 1)   return "#fde68a";
  return "#94a3b8";
}

export default function ScryingRanker() {
  const [expandedMaps, setExpandedMaps] = useState({});
  const [search, setSearch]             = useState("");
  const [sortBy, setSortBy]             = useState("ev");
  const [showCount, setShowCount]       = useState(25);

  const cardPrices = economyData?.cards || {};
  const league     = economyData?.league;
  const updatedAt  = economyData?.updated_at;
  const divinePrice = activeEconomy?.divine_price || 150;

  const rankedMaps = useMemo(() => {
    if (!mapData?.maps) return [];

    const maps = [];
    for (const [mapName, cards] of Object.entries(mapData.maps)) {
      let totalWeight = 0;
      for (const card of cards) totalWeight += card.weight;

      let totalEV = 0;
      const detailedCards = [];
      for (const card of cards) {
        const priceEntry = cardPrices[card.name];
        const price = priceEntry?.chaosValue || 0;
        const stackSize = priceEntry?.stackSize || 1;
        const dropChance = totalWeight > 0 ? card.weight / totalWeight : 0;
        const cardEV = dropChance * price;
        totalEV += cardEV;

        detailedCards.push({
          name: card.name,
          weight: card.weight,
          dropChance: dropChance * 100,
          price,
          stackSize,
          evContribution: cardEV,
        });
      }

      detailedCards.sort((a, b) => b.evContribution - a.evContribution);
      maps.push({
        name: mapName,
        totalWeight,
        evPerDrop: totalEV,
        cards: detailedCards,
      });
    }

    const byEv = [...maps].sort((a, b) => b.evPerDrop - a.evPerDrop);
    byEv.forEach((m, i) => { m.evRank = i + 1; });
    return maps;
  }, [cardPrices]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rankedMaps;
    if (q) {
      list = list.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        m.cards.some((c) => c.name.toLowerCase().includes(q))
      );
    }
    const keyFn = {
      ev:     (m) => m.evPerDrop,
      name:   (m) => m.name,
      weight: (m) => m.totalWeight,
    }[sortBy];
    const sorted = [...list].sort((a, b) => {
      const va = keyFn(a);
      const vb = keyFn(b);
      if (typeof va === "string") return va.localeCompare(vb);
      return vb - va;
    });
    return sorted;
  }, [rankedMaps, search, sortBy]);

  const visibleMaps = filtered.slice(0, showCount);
  const maxEV = rankedMaps.reduce((m, x) => Math.max(m, x.evPerDrop), 1);

  const toggleMap = (name) => {
    setExpandedMaps((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div style={{ color: "#e2e8f0" }}>
      <h2 style={{ fontSize: "22px", fontWeight: "bold", color: "#f59e0b", marginBottom: "4px" }}>
        Scrying Ranker
      </h2>
      <p style={{ color: "#94a3b8", marginBottom: "12px", fontSize: "14px", lineHeight: "1.5" }}>
        Expected divination-card value (in chaos) per card drop, by map. Use this to pick scry targets —
        higher EV means each card that drops is worth more on average.
      </p>

      <div style={{
        display: "flex", gap: "12px", flexWrap: "wrap",
        marginBottom: "12px", alignItems: "center", fontSize: "13px",
        color: "#64748b",
      }}>
        {rankedMaps.length} maps
        {league && <> · league: <span style={{ color: "#cbd5e1" }}>{league}</span></>}
        {updatedAt && (
          <> · prices: <span style={{ color: "#cbd5e1" }}>
            {new Date(updatedAt).toLocaleDateString()}
          </span></>
        )}
      </div>

      <div style={{
        display: "flex", gap: "12px", flexWrap: "wrap",
        marginBottom: "16px", alignItems: "center",
      }}>
        <input
          type="text"
          placeholder="Search map or card..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "6px 10px", fontSize: "13px", borderRadius: "4px",
            border: "1px solid #444", background: "#1e293b", color: "#e2e8f0",
            minWidth: "240px",
          }}
        />
        <label style={{ fontSize: "13px", color: "#94a3b8" }}>
          Sort by:{" "}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding: "6px 8px", fontSize: "13px", borderRadius: "4px",
              border: "1px solid #444", background: "#1e293b", color: "#e2e8f0",
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "13px", color: "#94a3b8" }}>
          Show:{" "}
          <select
            value={showCount}
            onChange={(e) => setShowCount(Number(e.target.value))}
            style={{
              padding: "6px 8px", fontSize: "13px", borderRadius: "4px",
              border: "1px solid #444", background: "#1e293b", color: "#e2e8f0",
            }}
          >
            {SHOW_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{
        background: "#1e293b", borderRadius: "8px",
        border: "1px solid #334155", overflow: "hidden",
      }}>
        {visibleMaps.length === 0 && (
          <div style={{ padding: "20px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
            No maps match your search.
          </div>
        )}

        {visibleMaps.map((mapInfo, idx) => {
          const isExpanded = !!expandedMaps[mapInfo.name];
          const barPct = Math.max(0, Math.min(100, (mapInfo.evPerDrop / maxEV) * 100));
          const rank = mapInfo.evRank;

          return (
            <div key={mapInfo.name} style={{
              borderTop: idx === 0 ? "none" : "1px solid #334155",
            }}>
              <div
                onClick={() => toggleMap(mapInfo.name)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "40px 1fr 120px 200px 24px",
                  gap: "12px",
                  alignItems: "center",
                  padding: "10px 14px",
                  cursor: "pointer",
                  background: isExpanded ? "#0f172a" : "transparent",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = "#253449"; }}
                onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ color: "#64748b", fontSize: "13px", fontWeight: "bold", textAlign: "right" }}>
                  #{rank}
                </span>
                <span style={{ color: "#f1f5f9", fontSize: "14px", fontWeight: 600 }}>
                  {mapInfo.name}
                </span>
                <span style={{
                  fontSize: "14px", fontWeight: "bold", textAlign: "right",
                  color: evColor(mapInfo.evPerDrop),
                }}>
                  {formatChaos(mapInfo.evPerDrop, divinePrice)}
                  <span style={{ color: "#64748b", fontSize: "11px", fontWeight: "normal", marginLeft: "4px" }}>
                    EV
                  </span>
                </span>
                <div style={{
                  height: "6px", background: "#0f172a", borderRadius: "3px",
                  overflow: "hidden", position: "relative",
                }}>
                  <div style={{
                    width: `${barPct}%`, height: "100%",
                    background: evColor(mapInfo.evPerDrop),
                    transition: "width 0.2s",
                  }} />
                </div>
                <span style={{ color: "#64748b", fontSize: "12px", textAlign: "center" }}>
                  {isExpanded ? "▾" : "▸"}
                </span>
              </div>

              {isExpanded && (
                <div style={{
                  background: "#0f172a", padding: "10px 14px 14px 14px",
                  borderTop: "1px solid #334155",
                }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                        <th style={{ padding: "6px 8px", fontWeight: "500" }}>Divination Card</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: "500" }}>Stack</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: "500" }}>Value/card</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: "500" }}>Drop %</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: "500" }}>Weight</th>
                        <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: "500" }}>EV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mapInfo.cards.map((c) => (
                        <tr key={c.name} style={{ borderTop: "1px solid #1e293b" }}>
                          <td style={{ padding: "5px 8px", color: "#e2e8f0" }}>{c.name}</td>
                          <td style={{ padding: "5px 8px", textAlign: "right", color: "#64748b" }}>
                            {c.stackSize}
                          </td>
                          <td style={{
                            padding: "5px 8px", textAlign: "right",
                            color: cardValueColor(c.price),
                          }}>
                            {formatChaos(c.price, divinePrice)}
                          </td>
                          <td style={{ padding: "5px 8px", textAlign: "right", color: "#94a3b8" }}>
                            {c.dropChance < 0.01 ? "<0.01" : c.dropChance.toFixed(2)}%
                          </td>
                          <td style={{ padding: "5px 8px", textAlign: "right", color: "#64748b" }}>
                            {c.weight.toLocaleString()}
                          </td>
                          <td style={{
                            padding: "5px 8px", textAlign: "right",
                            color: evColor(c.evContribution), fontWeight: 500,
                          }}>
                            {formatChaos(c.evContribution, divinePrice)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length > visibleMaps.length && (
        <div style={{
          marginTop: "8px", fontSize: "12px", color: "#64748b", textAlign: "center",
        }}>
          Showing {visibleMaps.length} of {filtered.length} matching maps.
        </div>
      )}
    </div>
  );
}
