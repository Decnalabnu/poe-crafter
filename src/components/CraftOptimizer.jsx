import { useState, useEffect } from "react";
import itemsData from "../data/items.json";
import { useEconomy } from "../contexts/EconomyContext";
import { parseItemText } from "../utils/itemParser";
import { generateCraftingRoutes } from "../utils/routePlanner";

const ITEM_CLASSES = [
  { value: "ring", label: "Ring" },
  { value: "amulet", label: "Amulet" },
  { value: "belt", label: "Belt" },
  { value: "body_armour", label: "Body Armour" },
  { value: "helmet", label: "Helmet" },
  { value: "boots", label: "Boots" },
  { value: "gloves", label: "Gloves" },
];

// Armour slot item classes that need a base type qualifier.
// The base type determines which subtype-tagged mods appear in the pool.
const ARMOUR_BASE_TAGS = [
  { value: "str_armour",         label: "Armour (STR)" },
  { value: "dex_armour",         label: "Evasion (DEX)" },
  { value: "int_armour",         label: "Energy Shield (INT)" },
  { value: "str_dex_armour",     label: "Armour/Evasion (STR/DEX)" },
  { value: "str_int_armour",     label: "Armour/ES (STR/INT)" },
  { value: "dex_int_armour",     label: "Evasion/ES (DEX/INT)" },
  { value: "str_dex_int_armour", label: "Armour/Eva/ES (STR/DEX/INT)" },
];

const ARMOUR_ITEM_CLASSES = new Set(["body_armour", "helmet", "boots", "gloves"]);

const INFLUENCES = [
  { id: "shaper",   label: "Shaper",   color: "#7bafdd" },
  { id: "elder",    label: "Elder",    color: "#c77be3" },
  { id: "crusader", label: "Crusader", color: "#e2c060" },
  { id: "hunter",   label: "Hunter",   color: "#7ec87e" },
  { id: "redeemer", label: "Redeemer", color: "#63c7b8" },
  { id: "warlord",  label: "Warlord",  color: "#e27b7b" },
];

const METHOD_COLORS = { chaos_spam: "#888", essence: "#9b59d4", fossil: "#e2b659", harvest: "#4CAF50" };
const METHOD_ICONS  = { chaos_spam: "⚗", essence: "💎", fossil: "🪨", harvest: "🌱" };

const ADVANCED_PLACEHOLDER = `Item Class: Body Armours
Rarity: Rare
Entropy Shelter
Twilight Regalia
--------
Item Level: 85
--------
{ Searing Exarch Implicit Modifier (Greater) — Resistance }
+1% to all maximum Resistances
{ Eater of Worlds Implicit Modifier (Grand) — Physical, Chaos }
11% of Physical Damage from Hits taken as Chaos Damage
--------
{ Fractured Prefix Modifier "Resplendent" (Tier: 1) — Defences, Energy Shield }
+100(91-100) to maximum Energy Shield
{ Prefix Modifier "Djinn's" (Tier: 2) — Defences, Energy Shield }
36(33-38)% increased Energy Shield
14(14-15)% increased Stun and Block Recovery
{ Suffix Modifier "of Haast" (Tier: 1) — Elemental, Cold, Resistance }
+48(46-48)% to Cold Resistance
{ Master Crafted Suffix Modifier "of Craft" (Rank: 3) — Elemental, Lightning, Resistance }
+34(29-35)% to Lightning Resistance`;

// ---------------------------------------------------------------------------
// ItemImportPanel
// ---------------------------------------------------------------------------
function ItemImportPanel({ onParsed }) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState(null);

  const handleParse = () => {
    setParseError(null);
    const result = parseItemText(text);
    if (result.error && !result.itemClass) {
      setParseError(result.error);
      return;
    }
    onParsed(result);
    if (result.error) setParseError(result.error);
  };

  return (
    <div style={{ marginBottom: "20px" }}>
      <label style={{ display: "block", fontWeight: "bold", color: "#aaa", fontSize: "13px", marginBottom: "6px", letterSpacing: "0.05em" }}>
        PASTE ITEM{" "}
        <span style={{ color: "#555", fontWeight: "normal" }}>(Ctrl+Alt+C in-game for mod details)</span>
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={ADVANCED_PLACEHOLDER}
        rows={9}
        style={{
          width: "100%", background: "#111", color: "#ddd",
          border: "1px solid #444", borderRadius: "4px", padding: "10px",
          fontSize: "12px", fontFamily: "monospace", resize: "vertical", boxSizing: "border-box",
        }}
      />
      <button
        onClick={handleParse}
        disabled={!text.trim()}
        style={{
          marginTop: "8px", padding: "8px 20px",
          background: text.trim() ? "#4CAF50" : "#333",
          color: text.trim() ? "#000" : "#555",
          border: "none", borderRadius: "4px",
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontWeight: "bold", fontSize: "14px",
        }}
      >
        Parse Item
      </button>
      {parseError && (
        <div style={{ marginTop: "8px", color: "#e2b659", fontSize: "12px" }}>⚠ {parseError}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ItemModChecklist — drives target selection directly from parsed mods.
// Fractured mods are locked (always excluded from re-rolling pool, passed as fracturedModId).
// Crafted mods are locked out (bench crafts, excluded from EV calculation).
// All other mods start checked as targets; user can uncheck to exclude.
// Unmatched mods (not found in items.json) are shown with a warning.
// ---------------------------------------------------------------------------
function ItemModChecklist({ mods, unmatched, checkedIds, onToggle, fracturedId }) {
  const prefixMods = mods.filter((m) => m.isPrefix);
  const suffixMods = mods.filter((m) => !m.isPrefix);

  function renderMod(mod) {
    const locked = mod.isFractured || mod.isCrafted;
    const isChecked = checkedIds.includes(mod.id);

    let statusBadge = null;
    let rowColor = mod.isPrefix ? "#c77be3" : "#6bbbe3";
    let lockReason = null;

    if (mod.isFractured) {
      statusBadge = <span style={{ fontSize: "10px", color: "#e2b659", border: "1px solid #e2b659", borderRadius: "2px", padding: "0 3px" }}>FRACTURED</span>;
      rowColor = "#e2b659";
      lockReason = "Fractured — always present, auto-set as base";
    } else if (mod.isCrafted) {
      statusBadge = <span style={{ fontSize: "10px", color: "#63c7b8", border: "1px solid #63c7b8", borderRadius: "2px", padding: "0 3px" }}>CRAFTED</span>;
      rowColor = "#63c7b8";
      lockReason = "Bench craft — added after rolling, not a target";
    }

    return (
      <div
        key={mod.id + mod.text}
        onClick={() => !locked && onToggle(mod.id)}
        style={{
          display: "flex", alignItems: "flex-start", gap: "10px",
          padding: "8px 10px", marginBottom: "4px",
          background: locked ? "#222" : isChecked ? "#1a2e1a" : "#1e1e1e",
          border: locked ? "1px solid #333" : isChecked ? "1px solid #4CAF50" : "1px solid #383838",
          borderRadius: "4px",
          cursor: locked ? "default" : "pointer",
          opacity: locked ? 0.7 : 1,
          userSelect: "none",
        }}
      >
        {/* Checkbox */}
        <div style={{
          width: "14px", height: "14px", marginTop: "1px", flexShrink: 0,
          border: `2px solid ${locked ? "#444" : isChecked ? "#4CAF50" : "#666"}`,
          borderRadius: "2px",
          background: locked ? "transparent" : isChecked ? "#4CAF50" : "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {(isChecked || locked) && !mod.isCrafted && (
            <span style={{ color: locked ? "#555" : "#000", fontSize: "10px", lineHeight: 1 }}>✓</span>
          )}
          {mod.isCrafted && (
            <span style={{ color: "#555", fontSize: "10px", lineHeight: 1 }}>—</span>
          )}
        </div>

        {/* Content */}
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <span style={{ color: rowColor, fontSize: "13px" }}>{mod.text}</span>
            <div style={{ display: "flex", gap: "4px", alignItems: "center", flexShrink: 0 }}>
              {statusBadge}
              <span style={{ color: "#555", fontSize: "11px" }}>
                {mod.group} {mod.tier != null ? `T${mod.tier}` : ""}
              </span>
            </div>
          </div>
          {lockReason && (
            <div style={{ color: "#555", fontSize: "11px", marginTop: "2px" }}>{lockReason}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "20px" }}>
        {/* Prefixes */}
        <div style={{ flex: 1 }}>
          <div style={{ color: "#c77be3", fontWeight: "bold", fontSize: "12px", borderBottom: "1px solid #555", paddingBottom: "5px", marginBottom: "8px" }}>
            PREFIXES
          </div>
          {prefixMods.length === 0
            ? <div style={{ color: "#444", fontSize: "12px" }}>None detected</div>
            : prefixMods.map(renderMod)
          }
        </div>

        {/* Suffixes */}
        <div style={{ flex: 1 }}>
          <div style={{ color: "#6bbbe3", fontWeight: "bold", fontSize: "12px", borderBottom: "1px solid #555", paddingBottom: "5px", marginBottom: "8px" }}>
            SUFFIXES
          </div>
          {suffixMods.length === 0
            ? <div style={{ color: "#444", fontSize: "12px" }}>None detected</div>
            : suffixMods.map(renderMod)
          }
        </div>
      </div>

      {unmatched.length > 0 && (
        <div style={{ marginTop: "10px", padding: "8px 10px", background: "#1a1500", border: "1px solid #3a3000", borderRadius: "4px" }}>
          <div style={{ color: "#666", fontSize: "11px", marginBottom: "6px" }}>
            ⚠ NOT IN ITEMS.JSON — displayed only, cannot be used for route calculation (run build_db.py to refresh):
          </div>
          {unmatched.map((mod, i) => {
            const m = typeof mod === "string" ? { text: mod, isPrefix: false, isFractured: false, isCrafted: false, tier: null } : mod;
            const typeColor = m.isCrafted ? "#63c7b8" : m.isFractured ? "#e2b659" : m.isPrefix ? "#c77be3" : "#6bbbe3";
            return (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
                <span style={{ color: typeColor, fontSize: "12px" }}>{m.text}</span>
                <span style={{ display: "flex", gap: "4px", flexShrink: 0, marginLeft: "10px" }}>
                  {m.isFractured && <span style={{ fontSize: "10px", color: "#e2b659", border: "1px solid #e2b659", borderRadius: "2px", padding: "0 3px" }}>FRAC</span>}
                  {m.isCrafted && <span style={{ fontSize: "10px", color: "#63c7b8", border: "1px solid #63c7b8", borderRadius: "2px", padding: "0 3px" }}>CRAFT</span>}
                  {m.tier && <span style={{ color: "#555", fontSize: "11px" }}>T{m.tier}</span>}
                  <span style={{ color: "#444", fontSize: "11px" }}>{m.isPrefix ? "prefix" : "suffix"}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RouteTable
// ---------------------------------------------------------------------------
function RouteTable({ routes: allRoutes, divinePrice }) {
  if (allRoutes.length === 0) return null;
  const routes = allRoutes.slice(0, 10);
  const cheapest = routes[0].expectedCostChaos;

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ color: "#4CAF50", fontWeight: "bold", fontSize: "12px", letterSpacing: "0.05em", marginBottom: "10px" }}>
        CRAFTING ROUTES — RANKED BY COST{allRoutes.length > 10 ? ` (top 10 of ${allRoutes.length})` : ""}
      </div>
      <div style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: "6px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ background: "#2a2a2a", color: "#888", textAlign: "left" }}>
              <th style={{ padding: "10px 12px", fontWeight: "normal", borderBottom: "1px solid #333" }}>Method</th>
              <th style={{ padding: "10px 12px", fontWeight: "normal", borderBottom: "1px solid #333", textAlign: "right" }}>P(hit)</th>
              <th style={{ padding: "10px 12px", fontWeight: "normal", borderBottom: "1px solid #333", textAlign: "right" }}>Avg Tries</th>
              <th style={{ padding: "10px 12px", fontWeight: "normal", borderBottom: "1px solid #333", textAlign: "right" }}>Avg Cost</th>
              <th style={{ padding: "10px 12px", fontWeight: "normal", borderBottom: "1px solid #333" }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route, idx) => {
              const isCheapest = route.expectedCostChaos === cheapest;
              const costDiv = (route.expectedCostChaos / divinePrice).toFixed(1);
              const isExpensive = route.expectedCostChaos > cheapest * 3;
              return (
                <tr key={idx} style={{
                  borderBottom: "1px solid #222",
                  background: isCheapest ? "#0f1f0f" : idx % 2 === 0 ? "#1e1e1e" : "#1a1a1a",
                  opacity: isExpensive ? 0.65 : 1,
                }}>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{ color: METHOD_COLORS[route.method] || "#aaa", marginRight: "6px" }}>
                      {METHOD_ICONS[route.method]}
                    </span>
                    <span style={{
                      color: isCheapest ? "#4CAF50" : route.method === "essence" && route.guaranteesTarget ? "#c77be3" : "#ddd",
                      fontWeight: isCheapest ? "bold" : "normal",
                    }}>
                      {route.label}
                    </span>
                    {isCheapest && (
                      <span style={{ marginLeft: "6px", fontSize: "10px", color: "#4CAF50", border: "1px solid #4CAF50", borderRadius: "3px", padding: "1px 4px" }}>BEST</span>
                    )}
                    {route.method === "essence" && route.guaranteesTarget && (
                      <span style={{ marginLeft: "6px", fontSize: "10px", color: "#c77be3", border: "1px solid #c77be3", borderRadius: "3px", padding: "1px 4px" }}>GUARANTEES TARGET</span>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#aaa" }}>{route.probability}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#ddd" }}>~{route.averageTries}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    <span style={{ color: isCheapest ? "#4CAF50" : "#e2b659", fontWeight: isCheapest ? "bold" : "normal" }}>
                      {Math.round(route.expectedCostChaos)}c
                    </span>
                    <span style={{ color: "#555", fontSize: "11px", marginLeft: "4px" }}>≈{costDiv}div</span>
                  </td>
                  <td style={{ padding: "10px 12px", color: "#666", fontSize: "12px" }}>{route.notes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function CraftOptimizer() {
  const economyData = useEconomy();
  const [parsedItem, setParsedItem] = useState(null);
  const [itemClass, setItemClass] = useState("ring");
  const [influence, setInfluence] = useState(null);
  const [armourBaseTag, setArmourBaseTag] = useState(null);
  // checkedIds = mod IDs selected as targets (from parsed item mods)
  const [checkedIds, setCheckedIds] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [hasCalculated, setHasCalculated] = useState(false);

  const divinePrice = economyData.divine_price || 150;

  function handleParsed(item) {
    setParsedItem(item);
    setRoutes([]);
    setHasCalculated(false);
    if (item.itemClass) setItemClass(item.itemClass);
    if (item.influence !== undefined) setInfluence(item.influence);
    if (item.armourBaseTag !== undefined) setArmourBaseTag(item.armourBaseTag ?? null);

    // Pre-check all matched mods that are neither fractured nor crafted
    const defaultChecked = (item.mods || [])
      .filter((m) => !m.isFractured && !m.isCrafted && m.id)
      .map((m) => m.id);
    setCheckedIds(defaultChecked);
  }

  function handleToggle(modId) {
    setCheckedIds((prev) =>
      prev.includes(modId) ? prev.filter((id) => id !== modId) : [...prev, modId]
    );
    setRoutes([]);
    setHasCalculated(false);
  }

  function handleGenerate() {
    const fracMod = parsedItem?.mods?.find((m) => m.isFractured);
    const fracturedModId = fracMod?.id ?? "none";

    const result = generateCraftingRoutes({
      itemClass,
      targetIds: checkedIds,
      influence,
      fracturedModId,
      armourBaseTag: ARMOUR_ITEM_CLASSES.has(itemClass) ? armourBaseTag : null,
      itemLevel: parsedItem?.itemLevel ?? null,
    });
    setRoutes(result);
    setHasCalculated(true);
  }

  const canGenerate = checkedIds.length > 0;

  // Item info summary line
  const itemInfoLine = parsedItem
    ? `${parsedItem.baseName || "Unknown Base"} — iLvl ${parsedItem.itemLevel ?? "?"}`
    : null;

  // Fractured mod may be matched or unmatched (if not in items.json)
  const fracMod = parsedItem?.mods?.find((m) => m.isFractured)
    ?? parsedItem?.unmatched?.find((m) => typeof m === "object" && m?.isFractured);

  return (
    <div style={{ background: "#2d2d2d", padding: "20px", borderRadius: "8px" }}>
      <div style={{ marginBottom: "16px", paddingBottom: "12px", borderBottom: "1px solid #444" }}>
        <h2 style={{ margin: "0 0 4px 0", fontSize: "18px", color: "#f8fafc" }}>Craft Optimizer</h2>
        <p style={{ margin: 0, color: "#666", fontSize: "13px" }}>
          Ctrl+Alt+C an item in-game, paste it here, then compare all crafting methods ranked by cost.
        </p>
      </div>

      <ItemImportPanel onParsed={handleParsed} />

      {/* Item class & influence — shown always for manual override */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "160px" }}>
          <label style={{ display: "block", color: "#aaa", fontSize: "12px", marginBottom: "4px" }}>ITEM CLASS</label>
          <select
            value={itemClass}
            onChange={(e) => { setItemClass(e.target.value); setCheckedIds([]); setRoutes([]); }}
            style={{ width: "100%", padding: "8px", background: "#111", color: "#fff", border: "1px solid #444", borderRadius: "4px", fontSize: "14px" }}
          >
            {ITEM_CLASSES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: "160px" }}>
          <label style={{ display: "block", color: "#aaa", fontSize: "12px", marginBottom: "4px" }}>INFLUENCE</label>
          <select
            value={influence ?? ""}
            onChange={(e) => { setInfluence(e.target.value || null); setCheckedIds([]); setRoutes([]); }}
            style={{ width: "100%", padding: "8px", background: "#111", color: "#fff", border: "1px solid #444", borderRadius: "4px", fontSize: "14px" }}
          >
            <option value="">None</option>
            {INFLUENCES.map((inf) => (
              <option key={inf.id} value={inf.id}>{inf.label}</option>
            ))}
          </select>
        </div>
        {ARMOUR_ITEM_CLASSES.has(itemClass) && (
          <div style={{ flex: 1, minWidth: "200px" }}>
            <label style={{ display: "block", color: "#aaa", fontSize: "12px", marginBottom: "4px" }}>
              BASE TYPE
              {!armourBaseTag && <span style={{ color: "#666", fontWeight: "normal", marginLeft: "6px" }}>(required for accurate odds)</span>}
            </label>
            <select
              value={armourBaseTag ?? ""}
              onChange={(e) => { setArmourBaseTag(e.target.value || null); setRoutes([]); setHasCalculated(false); }}
              style={{
                width: "100%", padding: "8px", background: "#111",
                color: armourBaseTag ? "#fff" : "#e2b659",
                border: `1px solid ${armourBaseTag ? "#444" : "#6a5500"}`,
                borderRadius: "4px", fontSize: "14px",
              }}
            >
              <option value="">— Select base type —</option>
              {ARMOUR_BASE_TAGS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Mod checklist — only shown after a successful parse */}
      {parsedItem && (
        <div style={{ marginBottom: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <div style={{ color: "#aaa", fontSize: "12px", fontWeight: "bold", letterSpacing: "0.05em" }}>
              TARGET MODS
              {checkedIds.length > 0 && (
                <span style={{ color: "#4CAF50", marginLeft: "8px", fontWeight: "normal" }}>
                  ({checkedIds.length} selected)
                </span>
              )}
            </div>
            {itemInfoLine && (
              <div style={{ color: "#555", fontSize: "11px" }}>{itemInfoLine}</div>
            )}
          </div>

          {fracMod && (
            <div style={{ marginBottom: "8px", padding: "6px 10px", background: "#1a1400", border: "1px solid #3a3000", borderRadius: "4px", fontSize: "12px", color: "#888" }}>
              Fractured base: <span style={{ color: "#e2b659" }}>{fracMod.group} T{fracMod.tier}</span>
              {" — will be passed as fracturedModId to calculator"}
            </div>
          )}

          <ItemModChecklist
            mods={parsedItem.mods}
            unmatched={parsedItem.unmatched}
            checkedIds={checkedIds}
            onToggle={handleToggle}
            fracturedId={fracMod?.id}
          />
        </div>
      )}

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={!canGenerate}
        style={{
          width: "100%", padding: "14px", fontSize: "16px",
          background: canGenerate ? "#4CAF50" : "#333",
          color: canGenerate ? "#000" : "#555",
          border: "none", borderRadius: "4px",
          cursor: canGenerate ? "pointer" : "not-allowed",
          fontWeight: "bold", marginBottom: "4px",
        }}
      >
        Generate Crafting Routes
      </button>

      {hasCalculated && routes.length === 0 && (
        <div style={{ marginTop: "12px", color: "#ff6666", fontSize: "13px" }}>
          No viable routes found. The selected mods may not be in items.json — run <code>python src/utils/build_db.py</code> to refresh.
        </div>
      )}

      <RouteTable routes={routes} divinePrice={divinePrice} />
    </div>
  );
}
