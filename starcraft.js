'use strict';

const fs = require('fs');
const path = require('path');

const SC_UNIT_MIN = 1;
const DATA_FILE = path.join(__dirname, 'data', 'sc_unit_data.json');
const TIER_WEIGHTS = Object.freeze({ 1: 40, 2: 25, 3: 15, 4: 5, 5: 1 });

let cachedCatalog = null;

function hashCode(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function loadUnitCatalog() {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  let weightedPool = [];
  let unitCount = 0;
  let factionMap = {}; // unitId → faction
  let factionPools = {}; // faction → [unitId, ...]

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.units)) {
      for (const unit of data.units) {
        const unitId = Number(unit && unit.unitId);
        if (!Number.isInteger(unitId) || unitId < SC_UNIT_MIN) {
          continue;
        }
        unitCount = Math.max(unitCount, unitId);
        const weight = TIER_WEIGHTS[unit.tier] || 1;
        for (let i = 0; i < weight; i += 1) {
          weightedPool.push(unitId);
        }
        if (unit.faction) {
          factionMap[unitId] = unit.faction;
          if (!factionPools[unit.faction]) {
            factionPools[unit.faction] = [];
          }
          factionPools[unit.faction].push(unitId);
        }
      }
    }
  } catch (_) {
    weightedPool = [];
  }

  if (weightedPool.length === 0) {
    unitCount = 49;
    for (let id = SC_UNIT_MIN; id <= unitCount; id += 1) {
      weightedPool.push(id);
    }
  }

  cachedCatalog = { weightedPool, unitCount, factionMap, factionPools };
  return cachedCatalog;
}

function getUnitIdForAgent(agentId) {
  if (!agentId) {
    return SC_UNIT_MIN;
  }

  const catalog = loadUnitCatalog();
  const index = hashCode(String(agentId)) % catalog.weightedPool.length;
  return catalog.weightedPool[index];
}

function getScUnitCount() {
  return loadUnitCatalog().unitCount;
}

function getFactionPool(unitId) {
  const catalog = loadUnitCatalog();
  const faction = catalog.factionMap[unitId];
  if (faction && catalog.factionPools[faction]) {
    return catalog.factionPools[faction];
  }
  return [unitId];
}

function resolveRenderedUnitIdForAgent(agentId, options = {}) {
  if (!agentId) {
    return SC_UNIT_MIN;
  }

  const parentId = options.parentId || null;
  if (!parentId) {
    return getUnitIdForAgent(agentId);
  }

  const getAgentById = typeof options.getAgentById === 'function' ? options.getAgentById : null;
  const lookupTs = typeof options.createdAt === 'number'
    ? options.createdAt
    : (typeof options.ts === 'number' ? options.ts : Infinity);
  let parentUnitId = null;

  if (getAgentById) {
    const parentAgent = getAgentById(parentId, { beforeTs: lookupTs });
    if (parentAgent) {
      parentUnitId = resolveRenderedUnitIdForAgent(parentId, {
        parentId: parentAgent.parentId || null,
        getAgentById,
        createdAt: typeof parentAgent.createdAt === 'number' ? parentAgent.createdAt : lookupTs
      });
    }
  }

  if (!parentUnitId) {
    parentUnitId = getUnitIdForAgent(parentId);
  }

  // Subagents pick from the same faction as their parent
  const candidates = getFactionPool(parentUnitId);
  return candidates[hashCode(String(agentId)) % candidates.length];
}

module.exports = {
  SC_UNIT_MIN,
  getScUnitCount,
  getUnitIdForAgent,
  getFactionPool,
  resolveRenderedUnitIdForAgent
};
