/**
 * build_db_dat.mjs
 *
 * Generates items.json and essences.json from PoE's official game data files,
 * fetched directly from the PoE CDN via pathofexile-dat.
 *
 * Usage:
 *   1. cd poe_export && npx pathofexile-dat   (downloads latest dat tables)
 *   2. node src/utils/build_db_dat.mjs        (generates items.json + essences.json)
 *
 * The poe_export/config.json must export these tables:
 *   Mods, ModType, Tags, Stats
 * and have a poe_export/stat_translations.json from RePoE for text generation.
 *
 * This script replaces build_db.py as the primary database builder.
 * Advantage: uses live PoE CDN data (always current) instead of RePoE's intermediate layer.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const POE_EXPORT = join(PROJECT_ROOT, "poe_export", "tables", "English");
const STAT_TRANS_PATH = join(PROJECT_ROOT, "poe_export", "stat_translations.json");
const ITEMS_OUTPUT = join(PROJECT_ROOT, "src", "data", "items.json");
const ESSENCES_OUTPUT = join(PROJECT_ROOT, "src", "data", "essences.json");

// Item classes we track
const ITEM_TAGS = ["ring", "amulet", "belt", "body_armour", "boots", "gloves", "helmet"];

// Armour subtypes — every armour item belongs to exactly one of these.
const ARMOUR_SUBTYPES = [
  "str_armour", "dex_armour", "int_armour",
  "str_dex_armour", "str_int_armour", "dex_int_armour", "str_dex_int_armour",
];

// Slot tag for each armour item class
const ARMOUR_SLOT_TAG = {
  body_armour: "body_armour",
  helmet: "helmet",
  boots: "boots",
  gloves: "gloves",
};

// Non-armour class tags
const ITEM_TAG_ALIASES = {
  ring: ["ring"],
  amulet: ["amulet"],
  belt: ["belt"],
};

// Maps dat tag names for influence variants → display name
const INFLUENCE_CODENAMES = {
  shaper: "shaper",
  elder: "elder",
  crusader: "crusader",
  basilisk: "hunter",
  eyrie: "redeemer",
  adjudicator: "warlord",
};

// Domain=1 = item domain in dat files
const ITEM_DOMAIN = 1;
// GenerationType=1 = prefix, 2 = suffix
const GEN_PREFIX = 1;
const GEN_SUFFIX = 2;

// ---------------------------------------------------------------------------
// Load dat tables
// ---------------------------------------------------------------------------
function loadTable(name) {
  const path = join(POE_EXPORT, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing dat table: ${path}\nRun: cd poe_export && npx pathofexile-dat`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Build stat translation lookup from RePoE stat_translations.json
// Mirrors the logic in build_db.py: build_translation_dicts()
// ---------------------------------------------------------------------------
function buildTranslationDicts(rawTranslations) {
  const transMulti = new Map(); // "id1|id2|..." → template string
  const transSingle = new Map(); // "id" → template string

  for (const block of rawTranslations) {
    if (!block.ids || !block.English) continue;
    const key = block.ids.join("|");
    if (transMulti.has(key)) continue; // first match wins (same as py)
    const str = block.English[0]?.string ?? "";
    transMulti.set(key, str);
    if (block.ids.length === 1 && !transSingle.has(block.ids[0])) {
      transSingle.set(block.ids[0], str);
    }
  }
  return { transMulti, transSingle };
}

// Replace {0}, {1}, ... placeholders with values, then fix "+-" → "-"
function substituteValues(template, values, offset = 0) {
  let result = template;
  for (let i = 0; i < values.length; i++) {
    result = result.replace(new RegExp(`\\{${i + offset}[^}]*\\}`, "g"), values[i]);
  }
  return result.replace("+-", "-");
}

// Format a single stat value range as a string
function formatValue(min, max) {
  if (min === max) return String(min);
  return `(${min} \u2014 ${max})`; // em-dash, matches in-game display
}

/**
 * Translate a list of {id, min, max} stats into a human-readable line.
 * Mirrors build_db.py: get_translated_string() + greedy window matching.
 */
function getTranslatedString(statsList, transMulti, transSingle) {
  if (!statsList.length) return "";

  const ids = statsList.map((s) => s.id);
  const values = statsList.map((s) => formatValue(s.min, s.max));

  // Try full tuple first
  const fullKey = ids.join("|");
  if (transMulti.has(fullKey)) {
    return substituteValues(transMulti.get(fullKey), values);
  }

  // Greedy window matching (largest window first)
  const lines = [];
  let i = 0;
  while (i < ids.length) {
    let matched = false;
    for (let w = ids.length - i; w >= 2; w--) {
      const windowKey = ids.slice(i, i + w).join("|");
      if (transMulti.has(windowKey)) {
        const tmpl = transMulti.get(windowKey);
        const windowVals = values.slice(i, i + w);
        let result = tmpl;
        for (let j = 0; j < windowVals.length; j++) {
          result = result.replace(new RegExp(`\\{${j}[^}]*\\}`, "g"), windowVals[j]);
        }
        lines.push(result.replace("+-", "-"));
        i += w;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const singleTmpl = transSingle.get(ids[i]) ?? "";
      if (singleTmpl) {
        lines.push(substituteValues(singleTmpl, [values[i]]).replace("+-", "-"));
      }
      i++;
    }
  }
  return lines.join(" / ");
}

// ---------------------------------------------------------------------------
// First-match spawn weight semantics (mirrors build_db.py)
// ---------------------------------------------------------------------------
function getFirstMatchWeight(spawnWeightMap, itemTagSet) {
  for (const { tag, weight } of spawnWeightMap) {
    if (itemTagSet.has(tag)) return weight;
  }
  return 0;
}

function computeBaseWeights(spawnWeightMap, slotTag) {
  const result = {};
  for (const subtype of ARMOUR_SUBTYPES) {
    const tagSet = new Set([subtype, slotTag, "armour", "default"]);
    result[subtype] = getFirstMatchWeight(spawnWeightMap, tagSet);
  }
  // Fallback: no subtype (slot+armour+default only)
  result["_any"] = getFirstMatchWeight(spawnWeightMap, new Set([slotTag, "armour", "default"]));
  return result;
}

// ---------------------------------------------------------------------------
// Tier assignment: T1 = best = highest required_level (tiebreak: lowest weight)
// Mirrors build_db.py: assign_tiers_to_pool()
// ---------------------------------------------------------------------------
function assignTiers(modList) {
  const groupIndices = new Map();
  for (let i = 0; i < modList.length; i++) {
    const g = modList[i].group;
    if (!groupIndices.has(g)) groupIndices.set(g, []);
    groupIndices.get(g).push(i);
  }

  const result = [...modList];
  for (const indices of groupIndices.values()) {
    const sorted = [...indices].sort((a, b) => {
      const lvlDiff = result[b]._required_level - result[a]._required_level;
      if (lvlDiff !== 0) return lvlDiff;
      const wA = result[a].spawn_weights?.[0]?.weight ?? 0;
      const wB = result[b].spawn_weights?.[0]?.weight ?? 0;
      return wA - wB; // lower weight = rarer = better
    });
    sorted.forEach((idx, tier) => {
      result[idx] = { ...result[idx], tier: tier + 1 };
    });
  }

  // Strip internal _required_level field
  return result.map(({ _required_level, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Main build function
// ---------------------------------------------------------------------------
async function buildDatabases() {
  console.log("Loading dat tables...");
  const rawMods = loadTable("Mods");
  const rawTags = loadTable("Tags");
  const rawModTypes = loadTable("ModType");
  const rawStats = loadTable("Stats");

  console.log("Loading stat translations from RePoE...");
  if (!existsSync(STAT_TRANS_PATH)) {
    throw new Error(
      `Missing stat_translations.json at ${STAT_TRANS_PATH}\n` +
      `Run: curl -s https://raw.githubusercontent.com/brather1ng/RePoE/master/RePoE/data/stat_translations.json -o poe_export/stat_translations.json`
    );
  }
  const rawTranslations = JSON.parse(readFileSync(STAT_TRANS_PATH, "utf8"));
  const { transMulti, transSingle } = buildTranslationDicts(rawTranslations);

  // Build lookups
  const tagById = Object.fromEntries(rawTags.map((t) => [t._index, t.Id]));
  const modTypeById = Object.fromEntries(rawModTypes.map((t) => [t._index, t.Name]));
  const statById = Object.fromEntries(rawStats.map((s) => [s._index, s.Id]));

  // Helper: extract stats list from a mod row
  function getStats(row) {
    const keys = [row.StatsKey1, row.StatsKey2, row.StatsKey3, row.StatsKey4, row.StatsKey5];
    const mins = [row.Stat1Min, row.Stat2Min, row.Stat3Min, row.Stat4Min, row.Stat5Min];
    const maxs = [row.Stat1Max, row.Stat2Max, row.Stat3Max, row.Stat4Max, row.Stat5Max];
    const out = [];
    for (let i = 0; i < 5; i++) {
      if (keys[i] == null) continue;
      const id = statById[keys[i]];
      if (!id) continue;
      out.push({ id, min: mins[i] ?? 0, max: maxs[i] ?? 0 });
    }
    return out;
  }

  // Helper: build spawn weight list as [{tag, weight}]
  function getSpawnWeights(row) {
    return row.SpawnWeight_TagsKeys.map((tk, i) => ({
      tag: tagById[tk] ?? "default",
      weight: row.SpawnWeight_Values[i] ?? 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // Parse essences data from RePoE (dat doesn't have user-friendly essence data)
  // ---------------------------------------------------------------------------
  console.log("Downloading RePoE essences data...");
  const ESSENCES_URL = "https://raw.githubusercontent.com/brather1ng/RePoE/master/RePoE/data/essences.json";
  const essResp = await fetch(ESSENCES_URL);
  const rawEssences = await essResp.json();

  const essClassMap = {
    Amulet: "amulet", Belt: "belt", "Body Armour": "body_armour",
    Boots: "boots", Gloves: "gloves", Helmet: "helmet", Ring: "ring",
  };

  const essenceDb = {};
  const essenceModsMap = new Map(); // modId → Set<tag>

  for (const essData of Object.values(rawEssences)) {
    const name = essData.name ?? "";
    if (!name) continue;
    const isEndgame = ["Deafening", "Horror", "Delirium", "Hysteria", "Insanity"].some((kw) =>
      name.includes(kw)
    );
    if (!isEndgame) continue;

    const cleanId = name.toLowerCase().replace(/ /g, "_");
    const guaranteedMods = Object.fromEntries(
      Object.entries(essData.mods ?? {})
        .filter(([k]) => k in essClassMap)
        .map(([k, v]) => [essClassMap[k], v])
    );

    for (const [tag, modId] of Object.entries(guaranteedMods)) {
      if (!essenceModsMap.has(modId)) essenceModsMap.set(modId, new Set());
      essenceModsMap.get(modId).add(tag);
    }

    essenceDb[cleanId] = { name, cost: 3, guaranteed_mods: guaranteedMods };
  }

  // ---------------------------------------------------------------------------
  // Build mod database from dat tables
  // ---------------------------------------------------------------------------
  console.log("Building item modifier database from dat tables...");
  const finalDb = Object.fromEntries(
    ITEM_TAGS.map((t) => [t, { prefixes: [], suffixes: [] }])
  );

  for (const mod of rawMods) {
    if (mod.Domain !== ITEM_DOMAIN) continue;
    if (mod.GenerationType !== GEN_PREFIX && mod.GenerationType !== GEN_SUFFIX) continue;

    const modId = mod.Id;
    const modGroup = modTypeById[mod.ModTypeKey] ?? "Unknown";
    // Convert CamelCase ModType name to "Title Case With Spaces" for display
    const modGroupDisplay = modGroup
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const stats = getStats(mod);
    const translatedText = getTranslatedString(stats, transMulti, transSingle);
    // Append [ModName] suffix if available (matches build_db.py format)
    const modName = mod.Name ?? "";
    const finalText =
      modName && translatedText
        ? `${translatedText} [${modName}]`
        : translatedText || `${modName} (${modGroupDisplay})`;

    const spawnWeightMap = getSpawnWeights(mod);
    const swMap = Object.fromEntries(spawnWeightMap.map(({ tag, weight }) => [tag, weight]));
    const defaultWeight = swMap["default"] ?? 0;
    const requiredLevel = mod.Level ?? 0;

    // Implicit tags (for fossil multiplier matching)
    const modTags = (mod.ImplicitTagsKeys ?? [])
      .map((k) => tagById[k])
      .filter(Boolean)
      .map((t) => t.toLowerCase());

    const isPrefix = mod.GenerationType === GEN_PREFIX;

    for (const tag of ITEM_TAGS) {
      const isArmourSlot = tag in ARMOUR_SLOT_TAG;
      let tagWeight;
      let baseWeights = null;

      if (isArmourSlot) {
        const slotTag = ARMOUR_SLOT_TAG[tag];
        baseWeights = computeBaseWeights(spawnWeightMap, slotTag);
        tagWeight = Math.max(...Object.values(baseWeights));
      } else {
        tagWeight = swMap[tag] ?? 0;
        if (tagWeight === 0) tagWeight = defaultWeight;
      }

      const isEssenceMod = essenceModsMap.has(modId) && essenceModsMap.get(modId).has(tag);

      if (tagWeight > 0 || isEssenceMod) {
        const formatted = {
          id: modId,
          group: modGroupDisplay,
          text: finalText,
          mod_tags: modTags,
          spawn_weights: [{ tag, weight: tagWeight }],
          required_level: requiredLevel,
          _required_level: requiredLevel,
        };
        if (baseWeights !== null) formatted.base_weights = baseWeights;

        if (isPrefix) {
          finalDb[tag].prefixes.push(formatted);
        } else {
          finalDb[tag].suffixes.push(formatted);
        }
      }

      // Influence-specific variants
      for (const [codename, displayName] of Object.entries(INFLUENCE_CODENAMES)) {
        const infTag = `${tag}_${codename}`;
        const infWeight = spawnWeightMap.find((sw) => sw.tag === infTag)?.weight ?? 0;
        if (infWeight > 0) {
          const influenced = {
            id: modId,
            group: modGroupDisplay,
            text: finalText,
            mod_tags: modTags,
            spawn_weights: [{ tag: infTag, weight: infWeight }],
            required_level: requiredLevel,
            _required_level: requiredLevel,
            influence: displayName,
          };
          if (isPrefix) {
            finalDb[tag].prefixes.push(influenced);
          } else {
            finalDb[tag].suffixes.push(influenced);
          }
        }
      }
    }
  }

  console.log("Assigning tiers...");
  for (const tag of ITEM_TAGS) {
    finalDb[tag].prefixes = assignTiers(finalDb[tag].prefixes);
    finalDb[tag].suffixes = assignTiers(finalDb[tag].suffixes);
  }

  // Build modId → group lookup from finalDb (post-tier-assignment)
  const modIdToGroup = new Map();
  for (const tag of ITEM_TAGS) {
    for (const m of [...finalDb[tag].prefixes, ...finalDb[tag].suffixes]) {
      if (!modIdToGroup.has(m.id)) modIdToGroup.set(m.id, m.group);
    }
  }

  // Add guaranteed_mod_groups to essences (maps each item class to the group name)
  for (const ess of Object.values(essenceDb)) {
    const groups = {};
    for (const [tag, modId] of Object.entries(ess.guaranteed_mods ?? {})) {
      const group = modIdToGroup.get(modId);
      if (group) groups[tag] = group;
    }
    if (Object.keys(groups).length > 0) ess.guaranteed_mod_groups = groups;
  }

  console.log("Writing output files...");
  mkdirSync(dirname(ITEMS_OUTPUT), { recursive: true });
  writeFileSync(ITEMS_OUTPUT, JSON.stringify(finalDb, null, 2));
  writeFileSync(ESSENCES_OUTPUT, JSON.stringify(essenceDb, null, 2));

  // Print summary stats
  for (const tag of ITEM_TAGS) {
    const p = finalDb[tag].prefixes.length;
    const s = finalDb[tag].suffixes.length;
    console.log(`  ${tag}: ${p} prefixes, ${s} suffixes`);
  }
  console.log("Done! items.json and essences.json updated from live PoE game data.");
}

buildDatabases().catch((err) => {
  console.error("Build failed:", err.message);
  process.exit(1);
});
