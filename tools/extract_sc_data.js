#!/usr/bin/env node

/**
 * extract_sc_data.js
 *
 * Parses StarCraft unit definitions from vendor-sc JavaScript source files
 * and outputs a JSON catalog at data/sc_unit_data.json.
 *
 * Strategy:
 *  1. Read each faction JS file as text
 *  2. Use regex + brace counting to extract each unit's prototypePlus and constructorPlus blocks
 *  3. Eval the prototypePlus block (safe: only arrays/primitives) to get imgPos, width, height, frame
 *  4. Check constructorPlus for alias patterns (e.g. this.imgPos.dock = this.imgPos.moving)
 *  5. Extract direction index 3 (south-facing) from imgPos arrays
 *  6. Assign tier and habitat metadata
 *  7. Write output JSON
 */

const fs = require('fs');
const path = require('path');

// --- Configuration ---

const VENDOR_DIR = path.join(__dirname, '..', 'vendor-sc', 'Characters');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'sc_unit_data.json');
const CHARAS_DIR = path.join(__dirname, '..', 'vendor-sc', 'img', 'Charas');

const FACTION_FILES = [
  { file: 'Zerg.js', faction: 'Zerg' },
  { file: 'Terran.js', faction: 'Terran' },
  { file: 'Protoss.js', faction: 'Protoss' },
  { file: 'Neutral.js', faction: 'Neutral' },
];

// Units to skip (variants, heroes, buildings, effects)
const SKIP_UNITS = new Set([
  'DragoonB', 'CorsairB',
  'Sarah', 'Kerrigan', 'HeroCruiser',
]);

const TIER_MAP = {
  1: ['Drone', 'Zergling', 'Marine', 'SCV', 'Probe', 'Zealot', 'Firebat', 'Medic', 'Civilian', 'Larva'],
  2: ['Hydralisk', 'Vulture', 'Dragoon', 'Ghost', 'Overlord', 'Lurker', 'Goliath', 'Templar', 'DarkTemplar'],
  3: ['Mutalisk', 'Wraith', 'Tank', 'Scout', 'Reaver', 'Queen', 'Valkyrie', 'Archon', 'Defiler'],
  4: ['Ultralisk', 'BattleCruiser', 'Guardian', 'Devourer', 'Carrier', 'Arbiter', 'DarkArchon', 'Vessel'],
  5: ['Broodling', 'InfestedTerran', 'Scourge', 'Corsair', 'Dropship', 'Shuttle', 'Observer', 'Ragnasaur', 'Rhynsdon', 'Ursadon', 'Bengalaas', 'Scantid', 'Kakaru'],
};

const FLYING_UNITS = new Set([
  'Overlord', 'Mutalisk', 'Guardian', 'Devourer', 'Scourge', 'Queen',
  'Wraith', 'Dropship', 'Vessel', 'BattleCruiser', 'Valkyrie',
  'Shuttle', 'Observer', 'Scout', 'Carrier', 'Arbiter', 'Corsair',
]);

// Build reverse tier lookup
const unitTier = {};
for (const [tier, units] of Object.entries(TIER_MAP)) {
  for (const u of units) {
    unitTier[u] = Number(tier);
  }
}

function getHabitat(unitName, faction) {
  if (faction === 'Neutral') return 'forest';
  const isFlying = FLYING_UNITS.has(unitName);
  switch (faction) {
    case 'Zerg':
      return isFlying ? 'sea' : 'cave';
    case 'Terran':
      return isFlying ? 'mountain' : 'grassland';
    case 'Protoss':
      return isFlying ? 'mountain' : 'forest';
    default:
      return 'forest';
  }
}

// --- Parsing helpers ---

/**
 * Extract a balanced brace block starting at a given position.
 * Returns the content between (and including) the outermost braces.
 */
function extractBraceBlock(text, startIdx) {
  let depth = 0;
  let start = -1;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return text.substring(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * From the prototypePlus block text, extract only the data properties
 * we care about: name, imgPos, width, height, frame.
 * We use brace counting to extract each top-level property.
 */
function extractPrototypeData(protoBlock) {
  // Remove the outer braces
  const inner = protoBlock.slice(1, -1);

  // We need to extract: name, imgPos, width, height, frame
  // Strategy: find each key and extract its value using brace counting for objects,
  // or simple parsing for primitives

  const result = {};

  // Extract name (string)
  const nameMatch = inner.match(/name\s*:\s*"([^"]+)"/);
  if (nameMatch) {
    result.name = nameMatch[1];
  }

  // Extract width (number)
  const widthMatch = inner.match(/width\s*:\s*(\d+)/);
  if (widthMatch) {
    result.width = Number(widthMatch[1]);
  }

  // Extract height (number)
  const heightMatch = inner.match(/height\s*:\s*(\d+)/);
  if (heightMatch) {
    result.height = Number(heightMatch[1]);
  }

  // Extract imgPos (object with nested arrays)
  const imgPosIdx = inner.indexOf('imgPos:');
  if (imgPosIdx === -1) {
    // Try with space
    const imgPosIdx2 = inner.indexOf('imgPos :');
    if (imgPosIdx2 !== -1) {
      const block = extractBraceBlock(inner, imgPosIdx2);
      if (block) {
        try {
          result.imgPos = new Function('return ' + block)();
        } catch (e) {
          console.error(`  Failed to parse imgPos: ${e.message}`);
        }
      }
    }
  } else {
    const block = extractBraceBlock(inner, imgPosIdx);
    if (block) {
      try {
        result.imgPos = new Function('return ' + block)();
      } catch (e) {
        console.error(`  Failed to parse imgPos: ${e.message}`);
      }
    }
  }

  // Extract frame (object)
  const frameIdx = inner.indexOf('frame:');
  if (frameIdx === -1) {
    const frameIdx2 = inner.indexOf('frame :');
    if (frameIdx2 !== -1) {
      const block = extractBraceBlock(inner, frameIdx2);
      if (block) {
        try {
          result.frame = new Function('return ' + block)();
        } catch (e) {
          console.error(`  Failed to parse frame: ${e.message}`);
        }
      }
    }
  } else {
    const block = extractBraceBlock(inner, frameIdx);
    if (block) {
      try {
        result.frame = new Function('return ' + block)();
      } catch (e) {
        console.error(`  Failed to parse frame: ${e.message}`);
      }
    }
  }

  return result;
}

/**
 * Parse constructorPlus to detect alias patterns like:
 *   this.imgPos.dock = this.imgPos.moving
 *   this.frame.dock = this.frame.moving
 *   this.imgPos.attack = this.imgPos.dock = this.imgPos.moving  (chained)
 */
function parseConstructorAliases(constructorBlock) {
  const imgPosAliases = {}; // e.g. { dock: 'moving', attack: 'moving' }
  const frameAliases = {};

  if (!constructorBlock) return { imgPosAliases, frameAliases };

  // Parse chained assignments like:
  //   this.imgPos.attack=this.imgPos.dock=this.imgPos.moving;
  // We find each full statement containing this.imgPos chains and extract all property names.
  // The rightmost one is the source; all others are aliases.
  function extractChainedAliases(block, prefix) {
    const aliases = {};
    // Match full statements containing chained this.PREFIX.X = this.PREFIX.Y [= ...];
    const stmtPattern = new RegExp(
      `(this\\.${prefix}\\.\\w+\\s*=\\s*)+this\\.${prefix}\\.\\w+`,
      'g'
    );
    let stmtMatch;
    while ((stmtMatch = stmtPattern.exec(block)) !== null) {
      const stmt = stmtMatch[0];
      // Extract all property names from this.PREFIX.X references
      const propPattern = new RegExp(`this\\.${prefix}\\.(\\w+)`, 'g');
      const props = [];
      let propMatch;
      while ((propMatch = propPattern.exec(stmt)) !== null) {
        props.push(propMatch[1]);
      }
      // Last one is the source, all others alias to it
      if (props.length >= 2) {
        const source = props[props.length - 1];
        for (let i = 0; i < props.length - 1; i++) {
          aliases[props[i]] = source;
        }
      }
    }
    return aliases;
  }

  return {
    imgPosAliases: extractChainedAliases(constructorBlock, 'imgPos'),
    frameAliases: extractChainedAliases(constructorBlock, 'frame'),
  };
}

/**
 * Extract direction index 3 (south-facing) from an imgPos state.
 *
 * For nested arrays (8 directions x N frames): left[3] gives the south-facing frame array
 * For flat arrays (8 directions x 1 frame each): left[3] is a single value, wrap in array
 */
function extractDirection3(stateData) {
  if (!stateData || !stateData.left || !stateData.top) return null;

  const leftArr = stateData.left;
  const topArr = stateData.top;

  let left, top;

  if (leftArr.length >= 4) {
    const leftVal = leftArr[3];
    const topVal = topArr[3];

    if (Array.isArray(leftVal)) {
      // Nested: 8 directions x N frames
      left = leftVal;
      top = topVal;
    } else {
      // Flat: 8 directions x 1 frame each -> wrap single value
      left = [leftVal];
      top = [topVal];
    }
  } else {
    // Less than 4 entries; use last available
    const idx = leftArr.length - 1;
    const leftVal = leftArr[idx];
    const topVal = topArr[idx];
    if (Array.isArray(leftVal)) {
      left = leftVal;
      top = topVal;
    } else {
      left = [leftVal];
      top = [topVal];
    }
  }

  return { left, top };
}

// --- Main extraction ---

function extractUnitsFromFile(filePath, faction) {
  const source = fs.readFileSync(filePath, 'utf-8');
  const units = [];

  // Match unit definitions: Faction.UnitName = AttackableUnit.extends({ or Unit.extends({
  const unitDefPattern = new RegExp(
    `${faction}\\.(\\w+)\\s*=\\s*(?:AttackableUnit|Unit)\\.extends\\(\\{`,
    'g'
  );

  let match;
  while ((match = unitDefPattern.exec(source)) !== null) {
    const unitKey = match[1];

    if (SKIP_UNITS.has(unitKey)) {
      console.log(`  Skipping ${unitKey} (excluded)`);
      continue;
    }

    console.log(`  Processing ${faction}.${unitKey}...`);

    const defStart = match.index + match[0].length - 1; // position of the opening {

    // Extract the full extends({ ... }) block
    const fullBlock = extractBraceBlock(source, defStart);
    if (!fullBlock) {
      console.error(`    Could not extract block for ${unitKey}`);
      continue;
    }

    // Extract constructorPlus block
    const ctorIdx = fullBlock.indexOf('constructorPlus');
    let constructorBlock = null;
    if (ctorIdx !== -1) {
      // Find the function body
      const funcStart = fullBlock.indexOf('{', fullBlock.indexOf('function', ctorIdx));
      if (funcStart !== -1) {
        constructorBlock = extractBraceBlock(fullBlock, funcStart);
      }
    }

    // Extract prototypePlus block
    const protoIdx = fullBlock.indexOf('prototypePlus');
    if (protoIdx === -1) {
      console.error(`    No prototypePlus found for ${unitKey}`);
      continue;
    }

    const protoStart = fullBlock.indexOf('{', protoIdx + 'prototypePlus'.length);
    if (protoStart === -1) {
      console.error(`    Could not find prototypePlus opening brace for ${unitKey}`);
      continue;
    }

    const protoBlock = extractBraceBlock(fullBlock, protoStart);
    if (!protoBlock) {
      console.error(`    Could not extract prototypePlus block for ${unitKey}`);
      continue;
    }

    // Parse the prototype data
    const data = extractPrototypeData(protoBlock);
    if (!data.name || !data.imgPos || !data.frame) {
      console.error(`    Missing required fields for ${unitKey}: name=${!!data.name} imgPos=${!!data.imgPos} frame=${!!data.frame}`);
      continue;
    }

    // Parse constructor aliases
    const { imgPosAliases, frameAliases } = parseConstructorAliases(constructorBlock);

    // Apply imgPos aliases
    for (const [alias, source] of Object.entries(imgPosAliases)) {
      if (data.imgPos[source]) {
        data.imgPos[alias] = data.imgPos[source];
      }
    }

    // Apply frame aliases
    for (const [alias, source] of Object.entries(frameAliases)) {
      if (data.frame[source] !== undefined) {
        data.frame[alias] = data.frame[source];
      }
    }

    // Extract direction 3 for each imgPos state, keep only states that exist
    const extractedImgPos = {};
    const extractedFrame = {};
    const STATES_TO_KEEP = ['moving', 'dock', 'attack'];

    for (const state of STATES_TO_KEEP) {
      if (data.imgPos[state] && data.frame[state] !== undefined) {
        const dir3 = extractDirection3(data.imgPos[state]);
        if (dir3) {
          extractedImgPos[state] = dir3;
          extractedFrame[state] = data.frame[state];
        }
      }
    }

    // Must have at least moving
    if (!extractedImgPos.moving) {
      console.error(`    No moving state found for ${unitKey}`);
      continue;
    }

    const tier = unitTier[data.name] || unitTier[unitKey];
    if (!tier) {
      console.warn(`    WARNING: No tier assigned for ${unitKey} (name: ${data.name})`);
      continue;
    }

    units.push({
      name: data.name,
      faction,
      spriteSheet: `${data.name}.png`,
      width: data.width,
      height: data.height,
      tier,
      habitat: getHabitat(data.name, faction),
      imgPos: extractedImgPos,
      frame: extractedFrame,
    });
  }

  return units;
}

// --- Run ---

console.log('StarCraft Unit Data Extractor');
console.log('============================\n');

const allUnits = [];

for (const { file, faction } of FACTION_FILES) {
  const filePath = path.join(VENDOR_DIR, file);
  console.log(`Reading ${file}...`);

  if (!fs.existsSync(filePath)) {
    console.error(`  File not found: ${filePath}`);
    continue;
  }

  const units = extractUnitsFromFile(filePath, faction);
  console.log(`  Extracted ${units.length} units from ${faction}\n`);
  allUnits.push(...units);
}

// Assign sequential unitIds
allUnits.forEach((unit, idx) => {
  unit.unitId = idx + 1;
});

// Reorder fields so unitId comes first
const finalUnits = allUnits.map(u => ({
  unitId: u.unitId,
  name: u.name,
  faction: u.faction,
  spriteSheet: u.spriteSheet,
  width: u.width,
  height: u.height,
  tier: u.tier,
  habitat: u.habitat,
  imgPos: u.imgPos,
  frame: u.frame,
}));

// Write output
const output = { units: finalUnits };
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');

console.log('============================');
console.log(`Total units extracted: ${finalUnits.length}`);
console.log(`Output written to: ${OUTPUT_PATH}\n`);

// Verify sprite sheets exist
console.log('Verifying sprite sheets...');
let missingCount = 0;
for (const unit of finalUnits) {
  const spritePath = path.join(CHARAS_DIR, unit.spriteSheet);
  if (!fs.existsSync(spritePath)) {
    console.error(`  MISSING: ${unit.spriteSheet} for ${unit.name}`);
    missingCount++;
  }
}
if (missingCount === 0) {
  console.log('  All sprite sheets found!\n');
} else {
  console.log(`  ${missingCount} sprite sheets missing!\n`);
}

// Print summary by faction
console.log('Summary by faction:');
const factionCounts = {};
for (const unit of finalUnits) {
  factionCounts[unit.faction] = (factionCounts[unit.faction] || 0) + 1;
}
for (const [faction, count] of Object.entries(factionCounts)) {
  console.log(`  ${faction}: ${count} units`);
}

console.log('\nSummary by tier:');
const tierCounts = {};
for (const unit of finalUnits) {
  tierCounts[unit.tier] = (tierCounts[unit.tier] || 0) + 1;
}
for (const [tier, count] of Object.entries(tierCounts)) {
  console.log(`  Tier ${tier}: ${count} units`);
}

console.log('\nUnit list:');
for (const unit of finalUnits) {
  console.log(`  [${unit.unitId}] ${unit.name} (${unit.faction}) - tier ${unit.tier}, ${unit.habitat}, ${Object.keys(unit.imgPos).join('/')}`);
}
