import React, { useMemo, useState } from "react";
import gemPricesData from "../data/gem_prices.json";

const SORT_OPTIONS = [
  { id: "profit",   label: "Profit (div)" },
  { id: "pct_gain", label: "% Gain" },
  { id: "top",      label: "Sell Price" },
  { id: "base",     label: "Buy Price" },
];

const CATEGORY_FILTERS = [
  { id: "all",         label: "All" },
  { id: "skill",       label: "Skill Gems" },
  { id: "support",     label: "Support Gems" },
  { id: "awakened",    label: "Awakened" },
  { id: "exceptional", label: "Exceptional (Enl/Emp/Enh)" },
];

const EXCEPTIONAL_NAMES = new Set([
  "Enlighten Support",
  "Empower Support",
  "Enhance Support",
]);

function classifyGem(gem) {
  if (EXCEPTIONAL_NAMES.has(gem.name)) return "exceptional";
  if (gem.name.startsWith("Awakened ") || (gem.category || "").includes("Awakened")) return "awakened";
  if (gem.name.endsWith(" Support")) return "support";
  return "skill";
}

function formatChaos(c, divine) {
  if (c == null) return "—";
  const d = divine || 150;
  if (Math.abs(c) >= d) return `${(c / d).toFixed(2)}d`;
  return `${c.toFixed(c < 10 ? 2 : 0)}c`;
}

function formatDivines(c, divine) {
  if (c == null) return "—";
  const d = divine || 150;
  const div = c / d;
  const abs = Math.abs(div);
  const decimals = abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return `${div.toFixed(decimals)}d`;
}

function profitColor(profit, divine) {
  const d = divine || 150;
  const div = profit / d;
  if (div > 1)     return "#4CAF50";
  if (div > 0.2)   return "#7ec87e";
  if (div > 0)     return "#a9c5a9";
  if (div > -0.05) return "#888";
  return "#e27b7b";
}

export default function GemXPTab() {
  const [sortBy, setSortBy]     = useState("profit");
  const [category, setCategory] = useState("all");
  const [search, setSearch]     = useState("");

  const { gems = [], fetched_at, league, divine_price } = gemPricesData || {};

  const rows = useMemo(() => {
    const filtered = gems.filter((g) => {
      if (category !== "all" && classifyGem(g) !== category) return false;
      if (search && !g.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    const key = {
      profit:   (g) => Math.abs(g.profit ?? 0),
      pct_gain: (g) => g.pct_gain ?? -Infinity,
      top:      (g) => g.top_price,
      base:     (g) => g.base_price,
    }[sortBy];
    return [...filtered].sort((a, b) => (key(b) ?? 0) - (key(a) ?? 0));
  }, [gems, category, search, sortBy]);

  const empty = gems.length === 0;

  return (
    <div style={{ color: "#e2e8f0" }}>
      <h2 style={{ fontSize: "22px", fontWeight: "bold", color: "#f59e0b", marginBottom: "4px" }}>
        Gem XP Profit
      </h2>
      <p style={{ color: "#94a3b8", marginBottom: "16px", fontSize: "14px" }}>
        Buy uncorrupted at level 1, level to max, sell uncorrupted. Quality-agnostic —
        cheapest listing at each level regardless of quality. Prices from GGG trade API.
      </p>

      {empty ? (
        <div style={{
          padding: "24px", background: "#1e293b", borderRadius: "8px",
          border: "1px solid #334155", fontSize: "14px", lineHeight: "1.6",
        }}>
          <strong style={{ color: "#f59e0b" }}>No gem price data yet.</strong>
          <div style={{ marginTop: "8px", color: "#cbd5e1" }}>
            Run the fetcher to populate it:
          </div>
          <pre style={{
            background: "#0f172a", padding: "10px", borderRadius: "4px",
            marginTop: "8px", fontSize: "13px", color: "#94a3b8",
          }}>python3 src/utils/fetch_gem_prices.py</pre>
          <div style={{ marginTop: "8px", color: "#94a3b8", fontSize: "13px" }}>
            Takes ~80 minutes the first time (rate-limited at ~12s/query, 2 queries per gem).
            Subsequent runs hit the 4-hour cache. Use <code>--limit 10</code> to smoke-test.
          </div>
        </div>
      ) : (
        <>
          <div style={{
            display: "flex", gap: "12px", flexWrap: "wrap",
            marginBottom: "12px", alignItems: "center", fontSize: "13px",
          }}>
            <div style={{ color: "#64748b" }}>
              {gems.length} gems priced · league: <span style={{ color: "#cbd5e1" }}>{league}</span>
              {" · "}divine: <span style={{ color: "#cbd5e1" }}>{divine_price}c</span>
              {fetched_at && (
                <>
                  {" · "}fetched: <span style={{ color: "#cbd5e1" }}>
                    {new Date(fetched_at).toLocaleString()}
                  </span>
                </>
              )}
            </div>
          </div>

          <div style={{
            display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px",
          }}>
            {CATEGORY_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setCategory(f.id)}
                style={{
                  padding: "6px 12px", fontSize: "13px", borderRadius: "4px",
                  cursor: "pointer", fontWeight: "bold",
                  background: category === f.id ? "#4CAF50" : "#2d2d2d",
                  color:      category === f.id ? "#000"    : "#aaa",
                  border:     category === f.id ? "none"    : "1px solid #444",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div style={{
            display: "flex", gap: "12px", flexWrap: "wrap",
            marginBottom: "16px", alignItems: "center",
          }}>
            <input
              type="text"
              placeholder="Search gem..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                padding: "6px 10px", fontSize: "13px", borderRadius: "4px",
                border: "1px solid #444", background: "#1e293b", color: "#e2e8f0",
                minWidth: "200px",
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
          </div>

          <div style={{
            background: "#1e293b", borderRadius: "8px",
            border: "1px solid #334155", overflow: "hidden",
          }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#0f172a", color: "#94a3b8", textAlign: "left" }}>
                  <th style={{ padding: "10px" }}>Gem</th>
                  <th style={{ padding: "10px", textAlign: "center" }}>Max Lvl</th>
                  <th style={{ padding: "10px", textAlign: "right" }}>Buy (lvl 1)</th>
                  <th style={{ padding: "10px", textAlign: "right" }}>Sell (max)</th>
                  <th style={{ padding: "10px", textAlign: "right" }}>Profit (div)</th>
                  <th style={{ padding: "10px", textAlign: "right" }}>% Gain</th>
                  <th style={{ padding: "10px", textAlign: "right", color: "#64748b" }}>Listings (buy/sell)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const pColor = profitColor(g.profit, divine_price);
                  return (
                    <tr key={g.name} style={{ borderTop: "1px solid #334155" }}>
                      <td style={{ padding: "8px 10px", color: "#f1f5f9" }}>{g.name}</td>
                      <td style={{ padding: "8px 10px", textAlign: "center", color: "#94a3b8" }}>
                        {g.max_level}
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>
                        {formatChaos(g.base_price, divine_price)}
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>
                        {formatChaos(g.top_price, divine_price)}
                      </td>
                      <td style={{
                        padding: "8px 10px", textAlign: "right",
                        color: pColor, fontWeight: "bold",
                      }}>
                        {formatDivines(g.profit, divine_price)}
                      </td>
                      <td style={{
                        padding: "8px 10px", textAlign: "right",
                        color: pColor,
                      }}>
                        {g.pct_gain != null ? `${g.pct_gain.toFixed(0)}%` : "—"}
                      </td>
                      <td style={{
                        padding: "8px 10px", textAlign: "right",
                        color: "#64748b", fontSize: "12px",
                      }}>
                        {g.base_listings}/{g.top_listings}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div style={{ padding: "20px", textAlign: "center", color: "#64748b" }}>
                No gems match your filters.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
