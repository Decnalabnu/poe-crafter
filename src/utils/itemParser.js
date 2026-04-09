import itemsData from "../data/items.json";
import armourBasesData from "../data/armour_bases.json";

const CLASS_MAP = {
  "body armours": "body_armour",
  "body armour": "body_armour",
  "rings": "ring",
  "ring": "ring",
  "amulets": "amulet",
  "amulet": "amulet",
  "belts": "belt",
  "belt": "belt",
  "helmets": "helmet",
  "helmet": "helmet",
  "boots": "boots",
  "gloves": "gloves",
};

// ---------------------------------------------------------------------------
// Ctrl+Alt+C format mod header parser
// e.g. { Fractured Prefix Modifier "Resplendent" (Tier: 1) — Defences, Energy Shield }
// e.g. { Master Crafted Suffix Modifier "of Craft" (Rank: 3) — Elemental, Lightning, Resistance }
// e.g. { Searing Exarch Implicit Modifier (Greater) — Resistance }
// ---------------------------------------------------------------------------
function parseModifierHeader(line) {
  if (!line.startsWith("{") || !line.endsWith("}")) return null;
  const inner = line.slice(1, -1).trim();
  const tierMatch = inner.match(/\(Tier:\s*(\d+)\)/i);
  return {
    isFractured: /fractured/i.test(inner),
    isCrafted: /master crafted/i.test(inner),
    isImplicit: /implicit/i.test(inner),
    isPrefix: /prefix/i.test(inner),
    isSuffix: /suffix/i.test(inner),
    tier: tierMatch ? parseInt(tierMatch[1], 10) : null,
  };
}

// Strip inline rolled values from Ctrl+Alt+C format.
// "+100(91-100)" → "+(91-100)"   |   "36(33-38)" → "(33-38)"
function stripRolledValues(line) {
  return line.replace(/([+\-]?)\d+(\.\d+)?(\()/g, "$1$3");
}

// Normalize to a comparable token string.
// Works on both items.json templates ("+(91 — 100) to maximum Energy Shield [Unfaltering]")
// and stripped clipboard values ("+(91-100) to maximum Energy Shield").
function normalizeMod(text) {
  return text
    .replace(/\[[^\]]*\]/g, "")          // strip [ModName] suffix appended by build_db.py
    .replace(/\([^)]+\)/g, "#")          // (91 — 100) or (91-100) → #
    .replace(/[+\-]?\d+(\.\d+)?/g, "#") // bare numbers → #
    .replace(/[+\-]#/g, "#")            // orphaned sign → strip
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Description/flavour lines we skip (not mod lines)
const SKIP_LINE_RE = /^(searing exarch item|eater of worlds item|shaper item|elder item|crusader item|hunter item|redeemer item|warlord item|synthesised item|fractured item|corrupted|mirrored|unidentified)$/i;
function isSkipLine(line) {
  const l = line.trim();
  // Parenthetical description lines e.g. "(Maximum Resistances cannot be raised above 90%)"
  if (l.startsWith("(") && l.endsWith(")")) return true;
  return SKIP_LINE_RE.test(l);
}

// Build normalized text → [mod, ...] lookup for an item class
function buildNormLookup(itemClass) {
  const pool = itemsData[itemClass];
  if (!pool) return new Map();
  const map = new Map();
  for (const mod of [...pool.prefixes, ...pool.suffixes]) {
    const key = normalizeMod(mod.text);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mod);
  }
  return map;
}

/**
 * Parse a Ctrl+Alt+C PoE item text into a structured object.
 *
 * Returns:
 *   itemClass  — "ring" | "helmet" | ... (null if unrecognized)
 *   rarity     — "Rare" | "Magic" | etc.
 *   baseName   — e.g. "Twilight Regalia"
 *   itemLevel  — integer
 *   influence  — detected influence or null
 *   implicits  — raw implicit mod strings (not matched)
 *   mods       — matched mods: { id, group, tier, text, isPrefix, isFractured, isCrafted, influence }
 *   unmatched  — mod lines that couldn't be matched to items.json
 */
export function parseItemText(rawText) {
  if (!rawText || !rawText.trim()) return { error: "Empty input" };

  const sections = rawText
    .split(/\r?\n-{8,}\r?\n/)
    .map((s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));

  // --- Header: Item Class, Rarity, item name, base name ---
  const header = sections[0] || [];
  let itemClass = null;
  let rarity = null;

  for (const line of header) {
    if (line.startsWith("Item Class:")) {
      itemClass = CLASS_MAP[line.replace("Item Class:", "").trim().toLowerCase()] ?? null;
    } else if (line.startsWith("Rarity:")) {
      rarity = line.replace("Rarity:", "").trim();
    }
  }

  const nameLines = header.filter(
    (l) => !l.startsWith("Item Class:") && !l.startsWith("Rarity:")
  );
  let baseName = rarity === "Rare" && nameLines.length >= 2
    ? nameLines[1]
    : nameLines[0] ?? null;

  // --- Item level ---
  let itemLevel = null;
  for (const section of sections) {
    for (const line of section) {
      const m = line.match(/^Item Level:\s*(\d+)/);
      if (m) { itemLevel = parseInt(m[1], 10); break; }
    }
    if (itemLevel !== null) break;
  }

  if (!itemClass) {
    return {
      itemClass: null, rarity, baseName, itemLevel,
      influence: null, implicits: [], mods: [], unmatched: [],
      error: "Unrecognized item class — only jewellery and armour slots are supported.",
    };
  }

  const lookup = buildNormLookup(itemClass);
  const prefixIds = new Set((itemsData[itemClass]?.prefixes || []).map((m) => m.id));

  // --- Parse mods by walking all sections looking for { } headers ---
  // Each { } header is followed by one or more value lines for that modifier.
  // Multi-stat mods (e.g. ES% + Stun recovery) appear as separate lines under
  // one header and are joined with " / " to match how build_db.py formats them.
  const implicits = [];
  const matched = [];
  const unmatched = [];

  for (const section of sections) {
    let currentHeader = null;
    let valueLines = [];

    const flush = () => {
      if (!currentHeader || valueLines.length === 0) { valueLines = []; return; }

      if (currentHeader.isImplicit) {
        implicits.push(valueLines.join(" / "));
        valueLines = [];
        return;
      }

      // Strip inline rolled values: "36(33-38)%" → "(33-38)%"
      const stripped = valueLines.map(stripRolledValues);
      const combined = stripped.join(" / ");
      const norm = normalizeMod(combined);
      const candidates = lookup.get(norm);

      if (candidates && candidates.length > 0) {
        // If header has explicit tier, find exact match; otherwise pick lowest tier number
        const byTier = currentHeader.tier
          ? candidates.find((m) => m.tier === currentHeader.tier)
          : null;
        const best = byTier ?? candidates.reduce((a, b) =>
          (a.tier ?? 99) < (b.tier ?? 99) ? a : b
        );
        matched.push({
          id: best.id,
          group: best.group,
          tier: best.tier,
          text: valueLines.join(" / "),
          isPrefix: prefixIds.has(best.id),
          isFractured: currentHeader.isFractured,
          isCrafted: currentHeader.isCrafted,
          influence: best.influence ?? null,
        });
      } else {
        // Still record unmatched mods with header metadata so they display sensibly
        unmatched.push({
          text: valueLines.join(" / "),
          isPrefix: currentHeader.isPrefix,
          isSuffix: currentHeader.isSuffix,
          isFractured: currentHeader.isFractured,
          isCrafted: currentHeader.isCrafted,
          tier: currentHeader.tier,
        });
      }
      valueLines = [];
    };

    for (const line of section) {
      const hdr = parseModifierHeader(line);
      if (hdr) {
        flush();
        currentHeader = hdr;
      } else if (currentHeader && !isSkipLine(line)) {
        valueLines.push(line);
      }
    }
    flush();
  }

  const infs = new Set(matched.map((m) => m.influence).filter(Boolean));
  const influence = infs.size === 1 ? [...infs][0] : null;

  // Auto-detect armour base type from base name (for pool filtering accuracy)
  let armourBaseTag = baseName ? (armourBasesData[baseName] ?? null) : null;

  // Fallback: infer from mod tags on matched mods (covers bases missing from armour_bases.json)
  const ARMOUR_CLASSES = new Set(["body_armour", "helmet", "boots", "gloves"]);
  if (!armourBaseTag && itemClass && ARMOUR_CLASSES.has(itemClass)) {
    const pool = itemsData[itemClass];
    if (pool) {
      const allPoolMods = [...pool.prefixes, ...pool.suffixes];
      let isStr = false, isDex = false, isInt = false;
      for (const mod of matched) {
        const poolMod = allPoolMods.find((m) => m.id === mod.id);
        if (poolMod?.mod_tags) {
          if (poolMod.mod_tags.includes("armour")) isStr = true;
          if (poolMod.mod_tags.includes("evasion")) isDex = true;
          if (poolMod.mod_tags.includes("energy_shield")) isInt = true;
        }
      }
      if (isStr || isDex || isInt) {
        const parts = [];
        if (isStr) parts.push("str");
        if (isDex) parts.push("dex");
        if (isInt) parts.push("int");
        armourBaseTag = parts.join("_") + "_armour";
      }
    }
  }

  return { itemClass, rarity, baseName, itemLevel, influence, armourBaseTag, implicits, mods: matched, unmatched };
}
