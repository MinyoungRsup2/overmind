'use strict';

const EventEmitter = require('events');
const { EVENT_TYPES } = require('./parser');

const STATUS = Object.freeze({
  IDLE: 'Idle',
  SLEEPING: 'Sleeping',
  THINKING: 'Thinking',
  TOOL: 'Tool-Running',
  OUTPUT: 'Outputting',
  WAITING: 'Waiting'
});

const DEFAULT_RING_SIZE = 300;
const DEFAULT_MAX_BOXED_AGENTS = 300;
const DEFAULT_MAX_SUBAGENT_HISTORY = 1000;
const DEFAULT_COUNTERS = Object.freeze({
  seen: 0,
  toolStarts: 0,
  toolEnds: 0,
  outputs: 0,
  waits: 0,
  spawns: 0
});

function cloneCounters(counters) {
  return {
    seen: counters && typeof counters.seen === 'number' ? counters.seen : 0,
    toolStarts: counters && typeof counters.toolStarts === 'number' ? counters.toolStarts : 0,
    toolEnds: counters && typeof counters.toolEnds === 'number' ? counters.toolEnds : 0,
    outputs: counters && typeof counters.outputs === 'number' ? counters.outputs : 0,
    waits: counters && typeof counters.waits === 'number' ? counters.waits : 0,
    spawns: counters && typeof counters.spawns === 'number' ? counters.spawns : 0
  };
}

function cloneAgentRecord(agent) {
  if (!agent) {
    return null;
  }

  return {
    agentId: agent.agentId,
    name: agent.name || agent.agentId,
    displayName: agent.displayName || null,
    subagentType: agent.subagentType || null,
    projectId: agent.projectId || 'unknown-project',
    sessionId: agent.sessionId || 'unknown-session',
    parentId: agent.parentId || undefined,
    childrenIds: new Set(Array.from(agent.childrenIds || [])),
    status: agent.status || STATUS.SLEEPING,
    activity: agent.activity || 'Restored',
    lastTool: agent.lastTool || null,
    lastCommand: agent.lastCommand || null,
    lastUserQuery: agent.lastUserQuery || null,
    lastSeen: agent.lastSeen || Date.now(),
    createdAt: agent.createdAt || Date.now(),
    contextUsed: agent.contextUsed || 0,
    contextMax: agent.contextMax || 200000,
    selfTokens: agent.selfTokens || 0,
    totalTokens: agent.totalTokens || 0,
    counters: cloneCounters(agent.counters)
  };
}

function isSubagent(agent) {
  return !!(agent && agent.parentId);
}

function pickBestAgentRecord(candidates, beforeTs) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const cutoff = typeof beforeTs === 'number' ? beforeTs : Infinity;
  let best = null;
  let bestCreatedAt = -Infinity;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : -Infinity;
    if (createdAt > cutoff) continue;
    if (!best || createdAt >= bestCreatedAt) {
      best = candidate;
      bestCreatedAt = createdAt;
    }
  }

  if (best) {
    return best;
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : -Infinity;
    if (!best || createdAt >= bestCreatedAt) {
      best = candidate;
      bestCreatedAt = createdAt;
    }
  }

  return best;
}

class AgentState extends EventEmitter {
  constructor(options = {}) {
    super();
    this.activeTimeoutMs = (options.activeTimeoutSec || 60) * 1000;
    this.staleTimeoutMs = (options.staleTimeoutSec || 300) * 1000;
    this.sessionCloseTimeoutMs = (options.sessionCloseTimeoutSec || 60) * 1000;
    this.boxSubagentsImmediately = options.boxSubagentsImmediately !== false;
    this.ringSize = options.ringSize || DEFAULT_RING_SIZE;
    this.maxBoxedAgents = Math.max(1, options.maxBoxedAgents || DEFAULT_MAX_BOXED_AGENTS);
    this.maxSubagentHistory = Math.max(1, options.maxSubagentHistory || DEFAULT_MAX_SUBAGENT_HISTORY);
    this.resolvePokemonId = typeof options.resolvePokemonId === 'function' ? options.resolvePokemonId : null;

    this.agents = new Map();
    this.boxedAgents = [];
    this.subagentHistory = [];
    this.recentEvents = [];
    this.lastUpdate = 0;
    this.seenPokemonIds = new Set();
    this.firstDiscoveryByPokemon = {};
  }

  trimHistoryBuffers() {
    if (this.boxedAgents.length > this.maxBoxedAgents) {
      this.boxedAgents.splice(0, this.boxedAgents.length - this.maxBoxedAgents);
    }
    if (this.subagentHistory.length > this.maxSubagentHistory) {
      this.subagentHistory.splice(0, this.subagentHistory.length - this.maxSubagentHistory);
    }
  }

  discoveryInfoForAgent(agentId, ts, meta = {}, agent = null) {
    const source = agent || {};
    const parentId = source.parentId || meta.parentId || null;
    const parentAgent = parentId
      ? this.lookupAgentById(parentId, { beforeTs: source.createdAt || ts })
      : null;
    return {
      agentId,
      agentName: source.displayName || meta.agentDescription || meta.sessionDisplayName || source.subagentType || meta.subagentType || agentId,
      projectId: meta.projectId || source.projectId || 'unknown-project',
      sessionId: meta.sessionId || source.sessionId || 'unknown-session',
      createdAt: source.createdAt || ts,
      discoveredAt: ts,
      parentId,
      parentName: parentAgent ? (parentAgent.displayName || parentAgent.subagentType || parentAgent.agentId) : null,
      viaSubagent: !!parentId
    };
  }

  recordSeenPokemon(agentId, ts = Date.now(), meta = {}, agent = null) {
    if (!this.resolvePokemonId || !agentId) {
      return false;
    }

    const pokemonId = this.resolvePokemonId(agentId, {
      ts,
      meta,
      agent,
      getAgentById: (id, lookupOptions = {}) => this.lookupAgentById(id, lookupOptions)
    });
    if (!Number.isInteger(pokemonId) || pokemonId < 1 || pokemonId > 251) {
      return false;
    }

    if (this.seenPokemonIds.has(pokemonId)) {
      return false;
    }

    this.seenPokemonIds.add(pokemonId);
    this.firstDiscoveryByPokemon[pokemonId] = this.discoveryInfoForAgent(agentId, ts, meta, agent);
    this.emit('pokedex', this.pokedexSnapshot());
    return true;
  }

  mergeSeenPokemonIds(ids, firstDiscoveryByPokemon = null) {
    let changed = false;
    const seenIds = Array.isArray(ids) ? ids : [];
    for (const rawId of seenIds) {
      const pokemonId = Number(rawId);
      if (!Number.isInteger(pokemonId) || pokemonId < 1 || pokemonId > 251 || this.seenPokemonIds.has(pokemonId)) {
        continue;
      }
      this.seenPokemonIds.add(pokemonId);
      if (firstDiscoveryByPokemon && firstDiscoveryByPokemon[pokemonId]) {
        this.firstDiscoveryByPokemon[pokemonId] = { ...firstDiscoveryByPokemon[pokemonId] };
      }
      changed = true;
    }

    if (changed) {
      this.emit('pokedex', this.pokedexSnapshot());
    }
    return changed;
  }

  refreshSeenPokemonFromAgents() {
    let changed = false;

    for (const agent of this.agents.values()) {
      const pokemonId = this.resolvePokemonId ? this.resolvePokemonId(agent.agentId, {
        agent,
        getAgentById: (id, lookupOptions = {}) => this.lookupAgentById(id, lookupOptions)
      }) : null;
      if (pokemonId && this.seenPokemonIds.has(pokemonId) && !this.firstDiscoveryByPokemon[pokemonId]) {
        this.firstDiscoveryByPokemon[pokemonId] = this.discoveryInfoForAgent(agent.agentId, agent.createdAt || Date.now(), {}, agent);
        changed = true;
        continue;
      }
      changed = this.recordSeenPokemon(agent.agentId, agent.createdAt || Date.now(), {}, agent) || changed;
    }
    for (const agent of this.boxedAgents) {
      const pokemonId = this.resolvePokemonId ? this.resolvePokemonId(agent.agentId, {
        agent,
        getAgentById: (id, lookupOptions = {}) => this.lookupAgentById(id, lookupOptions)
      }) : null;
      if (pokemonId && this.seenPokemonIds.has(pokemonId) && !this.firstDiscoveryByPokemon[pokemonId]) {
        this.firstDiscoveryByPokemon[pokemonId] = this.discoveryInfoForAgent(agent.agentId, agent.createdAt || Date.now(), {}, agent);
        changed = true;
        continue;
      }
      changed = this.recordSeenPokemon(agent.agentId, agent.createdAt || Date.now(), {}, agent) || changed;
    }

    for (const agent of this.subagentHistory) {
      const pokemonId = this.resolvePokemonId ? this.resolvePokemonId(agent.agentId, {
        agent,
        getAgentById: (id, lookupOptions = {}) => this.lookupAgentById(id, lookupOptions)
      }) : null;
      if (pokemonId && this.seenPokemonIds.has(pokemonId) && !this.firstDiscoveryByPokemon[pokemonId]) {
        this.firstDiscoveryByPokemon[pokemonId] = this.discoveryInfoForAgent(agent.agentId, agent.createdAt || Date.now(), {}, agent);
        changed = true;
        continue;
      }
      changed = this.recordSeenPokemon(agent.agentId, agent.createdAt || Date.now(), {}, agent) || changed;
    }

    return changed;
  }

  lookupAgentById(agentId, options = {}) {
    if (!agentId) {
      return null;
    }

    const candidates = [];
    const live = this.agents.get(agentId);
    if (live) {
      candidates.push(live);
    }

    for (let i = this.boxedAgents.length - 1; i >= 0; i -= 1) {
      if (this.boxedAgents[i] && this.boxedAgents[i].agentId === agentId) {
        candidates.push(this.boxedAgents[i]);
      }
    }

    for (let i = this.subagentHistory.length - 1; i >= 0; i -= 1) {
      if (this.subagentHistory[i] && this.subagentHistory[i].agentId === agentId) {
        candidates.push(this.subagentHistory[i]);
      }
    }

    return pickBestAgentRecord(candidates, options.beforeTs);
  }

  pokedexSnapshot() {
    const seenPokemonIds = Array.from(this.seenPokemonIds).sort((a, b) => a - b);
    const firstDiscoveryByPokemon = {};
    for (const pokemonId of seenPokemonIds) {
      if (this.firstDiscoveryByPokemon[pokemonId]) {
        firstDiscoveryByPokemon[pokemonId] = { ...this.firstDiscoveryByPokemon[pokemonId] };
      }
    }
    return {
      seenPokemonIds,
      firstDiscoveryByPokemon,
      discoveredCount: seenPokemonIds.length,
      totalCount: 251
    };
  }

  upsertAgent(agentId, ts, meta = {}) {
    let created = false;
    let agent = this.agents.get(agentId);

    if (!agent) {
      created = true;
      agent = {
        agentId,
        name: agentId,
        displayName: null,
        subagentType: null,
        projectId: meta.projectId || 'unknown-project',
        sessionId: meta.sessionId || 'unknown-session',
        parentId: meta.parentId && meta.parentId !== agentId ? meta.parentId : undefined,
        childrenIds: new Set(),
        status: STATUS.THINKING,
        activity: 'Seen',
        lastTool: null,
        lastCommand: null,
        lastUserQuery: null,
        lastSeen: ts,
        createdAt: ts,
        contextUsed: meta.contextUsed || 0,
        contextMax: meta.contextMax || 200000,
        selfTokens: 0,
        totalTokens: 0,
        counters: cloneCounters(DEFAULT_COUNTERS)
      };
      this.agents.set(agentId, agent);
    }

    agent.lastSeen = Math.max(agent.lastSeen || 0, ts);
    if (meta.projectId) {
      agent.projectId = meta.projectId;
    }
    if (meta.sessionId) {
      agent.sessionId = meta.sessionId;
    }
    if (meta.parentId && meta.parentId !== agentId) {
      agent.parentId = meta.parentId;
    }
    if (typeof meta.contextUsed === 'number') {
      agent.contextUsed = meta.contextUsed;
    }
    if (typeof meta.contextMax === 'number') {
      agent.contextMax = meta.contextMax;
    }

    if (agent.parentId) {
      const parent = this.agents.get(agent.parentId);
      if (parent) {
        parent.childrenIds.add(agent.agentId);
      }
    }

    return { agent, created };
  }

  addTokenUsage(agentId, tokens) {
    const amount = Number(tokens);
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    agent.selfTokens = (agent.selfTokens || 0) + amount;

    let current = agent;
    let guard = 0;
    while (current && guard < 32) {
      current.totalTokens = (current.totalTokens || 0) + amount;
      if (!current.parentId) {
        break;
      }
      current = this.agents.get(current.parentId) || null;
      guard += 1;
    }
  }

  pushRecentEvent(event) {
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.ringSize) {
      this.recentEvents.splice(0, this.recentEvents.length - this.ringSize);
    }
  }

  ensureParentLink(parentId, childId, ts, meta = {}) {
    if (!parentId || parentId === childId) {
      return null;
    }

    const parentMeta = {
      projectId: meta.projectId,
      sessionId: meta.sessionId
    };
    const parent = this.agents.get(parentId) || this.upsertAgent(parentId, ts, parentMeta).agent;
    parent.childrenIds.add(childId);
    return parent;
  }

  applyEvent(event) {
    if (!event || !event.agentId || !event.type) {
      return;
    }

    const ts = typeof event.ts === 'number' ? event.ts : Date.now();
    const meta = event.meta || {};

    // Auto-unbox: if this agent was boxed and a new event arrives, restore it first
    if (!this.agents.has(event.agentId)) {
      const boxIdx = this.boxedAgents.findIndex((b) => b.agentId === event.agentId);
      if (boxIdx >= 0) {
        const boxed = this.boxedAgents.splice(boxIdx, 1)[0];
        this.agents.set(event.agentId, {
          agentId: boxed.agentId,
          name: boxed.agentId,
          displayName: boxed.displayName || null,
          subagentType: boxed.subagentType || null,
          projectId: boxed.projectId,
          sessionId: boxed.sessionId,
          parentId: undefined,
          childrenIds: new Set(),
          status: STATUS.THINKING,
          activity: 'Resumed',
          lastTool: null,
          lastCommand: boxed.lastCommand || null,
          lastUserQuery: boxed.lastUserQuery || null,
          lastSeen: ts,
          createdAt: boxed.createdAt || ts,
          contextUsed: boxed.contextUsed || 0,
          contextMax: boxed.contextMax || 200000,
          selfTokens: boxed.selfTokens || 0,
          totalTokens: boxed.totalTokens || 0,
          counters: cloneCounters(boxed.counters)
        });
      }
    }

    const { agent, created } = this.upsertAgent(event.agentId, ts, meta);
    const previousStatus = agent.status;

    if (event.type === EVENT_TYPES.AGENT_SEEN) {
      agent.counters.seen += 1;
    }

    if (created && agent.parentId) {
      this.ensureParentLink(agent.parentId, agent.agentId, ts, meta);
    }

    if (created && agent.parentId && event.type !== EVENT_TYPES.SUBAGENT_SPAWN) {
      const inferredMeta = {
        ...meta,
        parentId: agent.parentId,
        inferred: true
      };

      // Apply description from meta (sourced from .meta.json via watcher)
      if (inferredMeta.agentDescription && !agent.displayName) {
        agent.displayName = inferredMeta.agentDescription;
      }
      if (inferredMeta.subagentType && !agent.subagentType) {
        agent.subagentType = inferredMeta.subagentType;
      }

      // Try parent's pending descriptions as fallback
      if (!agent.displayName || !agent.subagentType) {
        const parent = this.agents.get(agent.parentId);
        if (parent && parent._pendingChildDescriptions && parent._pendingChildDescriptions.length > 0) {
          const pending = parent._pendingChildDescriptions.shift();
          if (!agent.displayName && pending.description) agent.displayName = pending.description;
          if (!agent.subagentType && pending.subagentType) agent.subagentType = pending.subagentType;
        }
      }

      const inferredSpawn = {
        type: EVENT_TYPES.SUBAGENT_SPAWN,
        agentId: agent.agentId,
        ts,
        meta: inferredMeta
      };
      this.pushRecentEvent(inferredSpawn);
    }

    switch (event.type) {
      case EVENT_TYPES.AGENT_SEEN:
        if (agent.status === STATUS.IDLE || agent.status === STATUS.SLEEPING || !agent.status) {
          agent.status = STATUS.THINKING;
          agent.activity = 'Active';
        }
        // Apply session display name from first user message to main session agents
        if (!agent.displayName && meta.sessionDisplayName) {
          agent.displayName = meta.sessionDisplayName;
        }
        if (meta.lastUserQuery) {
          agent.lastUserQuery = meta.lastUserQuery;
        }
        break;
      case EVENT_TYPES.TOOL_START:
        agent.status = STATUS.TOOL;
        agent.activity = 'Running Tool';
        agent.lastTool = meta.toolName || agent.lastTool;
        if (meta.lastCommand) {
          agent.lastCommand = meta.lastCommand;
        }
        agent.counters.toolStarts += 1;
        // Store pending description for next child agent spawned by this parent
        if ((meta.toolName === 'Agent' || meta.toolName === 'agent') && meta.agentDescription) {
          if (!agent._pendingChildDescriptions) agent._pendingChildDescriptions = [];
          agent._pendingChildDescriptions.push({
            description: meta.agentDescription,
            subagentType: meta.subagentType || null,
            ts
          });
        }
        break;
      case EVENT_TYPES.TOOL_END:
        agent.status = STATUS.THINKING;
        agent.activity = 'Tool Finished';
        agent.lastTool = meta.toolName || agent.lastTool;
        if (meta.lastCommand) {
          agent.lastCommand = meta.lastCommand;
        }
        agent.counters.toolEnds += 1;
        break;
      case EVENT_TYPES.ASSISTANT_OUTPUT:
        agent.status = STATUS.OUTPUT;
        agent.activity = 'Outputting';
        agent.counters.outputs += 1;
        if (typeof meta.totalTokens === 'number' && meta.totalTokens > 0) {
          this.addTokenUsage(agent.agentId, meta.totalTokens);
        }
        break;
      case EVENT_TYPES.WAITING:
        agent.status = STATUS.WAITING;
        agent.activity = 'Waiting';
        agent.counters.waits += 1;
        break;
      case EVENT_TYPES.SUBAGENT_SPAWN: {
        const parentId = meta.parentId;
        if (parentId) {
          this.ensureParentLink(parentId, agent.agentId, ts, meta);
          agent.parentId = parentId;
        }
        agent.status = STATUS.THINKING;
        agent.activity = 'Spawned';
        agent.counters.spawns += 1;
        // Apply description from spawn event meta
        if (meta.agentDescription && !agent.displayName) {
          agent.displayName = meta.agentDescription;
        }
        if (meta.subagentType && !agent.subagentType) {
          agent.subagentType = meta.subagentType;
        }
        // Try to get description from parent's pending list
        if (parentId && (!agent.displayName || !agent.subagentType)) {
          const parent = this.agents.get(parentId);
          if (parent && parent._pendingChildDescriptions && parent._pendingChildDescriptions.length > 0) {
            const pending = parent._pendingChildDescriptions.shift();
            if (!agent.displayName && pending.description) agent.displayName = pending.description;
            if (!agent.subagentType && pending.subagentType) agent.subagentType = pending.subagentType;
          }
        }
        break;
      }
      case EVENT_TYPES.AGENT_DONE:
        if (isSubagent(agent)) {
          this.recordSubagentHistory(agent, ts);
        } else {
          this.boxAgent(agent);
        }
        this.removeAgent(agent.agentId);
        this.pushRecentEvent(event);
        this.lastUpdate = Date.now();
        this.emit('update', this.snapshot());
        return;
      default:
        break;
    }

    this.pushRecentEvent(event);
    this.lastUpdate = Date.now();
    const pokedexChanged = this.recordSeenPokemon(event.agentId, ts, meta, agent);

    if (pokedexChanged || agent.status !== previousStatus || created || event.type !== EVENT_TYPES.AGENT_SEEN) {
      this.emit('update', this.snapshot());
    }
  }

  boxAgent(agent) {
    this.boxedAgents.push({
      agentId: agent.agentId,
      displayName: agent.displayName || null,
      subagentType: agent.subagentType || null,
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      parentId: agent.parentId || null,
      contextUsed: agent.contextUsed || 0,
      contextMax: agent.contextMax || 200000,
      selfTokens: agent.selfTokens || 0,
      totalTokens: agent.totalTokens || 0,
      lastCommand: agent.lastCommand || null,
      lastUserQuery: agent.lastUserQuery || null,
      createdAt: agent.createdAt,
      doneAt: Date.now(),
      counters: cloneCounters(agent.counters)
    });
    this.trimHistoryBuffers();
  }

  recordSubagentHistory(agent, doneAt = Date.now()) {
    if (!isSubagent(agent)) return;
    const exists = this.subagentHistory.some((entry) =>
      entry.agentId === agent.agentId &&
      entry.createdAt === agent.createdAt &&
      Math.abs((entry.doneAt || 0) - doneAt) < 5000
    );
    if (exists) return;

    this.subagentHistory.push({
      agentId: agent.agentId,
      displayName: agent.displayName || null,
      subagentType: agent.subagentType || null,
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      parentId: agent.parentId || null,
      contextUsed: agent.contextUsed || 0,
      contextMax: agent.contextMax || 200000,
      selfTokens: agent.selfTokens || 0,
      totalTokens: agent.totalTokens || 0,
      lastCommand: agent.lastCommand || null,
      lastUserQuery: agent.lastUserQuery || null,
      createdAt: agent.createdAt,
      doneAt,
      counters: cloneCounters(agent.counters)
    });
    this.trimHistoryBuffers();
  }

  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Recursively remove all children first
    for (const childId of agent.childrenIds) {
      this.removeAgent(childId);
    }

    // Remove from parent's childrenIds
    if (agent.parentId) {
      const parent = this.agents.get(agent.parentId);
      if (parent) {
        parent.childrenIds.delete(agentId);
      }
    }

    this.agents.delete(agentId);
  }

  tick(now = Date.now()) {
    let changed = false;

    for (const [agentId, agent] of this.agents.entries()) {
      const subagent = isSubagent(agent);

      if (subagent && this.boxSubagentsImmediately) { // live transcripts drop subagents aggressively to reduce stragglers
        this.recordSubagentHistory(agent, now);
        this.removeAgent(agentId);
        changed = true;
        continue;
      }

      const age = now - agent.lastSeen;

      if (subagent && age >= this.activeTimeoutMs) {
        this.recordSubagentHistory(agent, now);
        this.removeAgent(agentId);
        changed = true;
        continue;
      }

      if (age >= this.staleTimeoutMs) {
        if (!subagent) {
          this.boxAgent(agent);
        }
        this.removeAgent(agentId);
        changed = true;
        continue;
      }

      if (age >= this.activeTimeoutMs && agent.status !== STATUS.SLEEPING) {
        agent.status = STATUS.SLEEPING;
        agent.activity = 'Sleeping';
        changed = true;
      }
    }

    if (changed) {
      this.lastUpdate = now;
      this.emit('update', this.snapshot());
    }
  }

  /**
   * Check live session PIDs and box agents whose session process has exited.
   * @param {Map<string,number>} sessionPidMap  sessionId → PID from ~/.claude/sessions/
   */
  checkSessionPids(sessionPidMap) {
    let changed = false;

    for (const [agentId, agent] of this.agents.entries()) {
      if (agent.parentId) continue; // subagents handled elsewhere

      const pid = sessionPidMap.get(agent.sessionId);
      if (pid === undefined) continue; // no PID info — skip, let normal timeout handle it

      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (_) {
        // process gone
      }

      if (!alive) {
        this.boxAgent(agent);
        this.removeAgent(agentId);
        changed = true;
      }
    }

    if (changed) {
      this.lastUpdate = Date.now();
      this.emit('update', this.snapshot());
    }
  }

  manualBox(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this.boxAgent(agent);
    this.removeAgent(agentId);
    this.lastUpdate = Date.now();
    this.emit('update', this.snapshot());
    return true;
  }

  manualUnbox(agentId) {
    const idx = this.boxedAgents.findIndex((b) => b.agentId === agentId);
    if (idx < 0) return false;
    const boxed = this.boxedAgents.splice(idx, 1)[0];
    const now = Date.now();
    const agent = {
      agentId: boxed.agentId,
      name: boxed.agentId,
      displayName: boxed.displayName || null,
      subagentType: boxed.subagentType || null,
      projectId: boxed.projectId,
      sessionId: boxed.sessionId,
      parentId: undefined,
      childrenIds: new Set(),
      status: STATUS.SLEEPING,
      activity: 'Sleeping',
      lastTool: null,
      lastCommand: boxed.lastCommand || null,
      lastUserQuery: boxed.lastUserQuery || null,
      lastSeen: boxed.doneAt || now,
      createdAt: boxed.createdAt || now,
      contextUsed: boxed.contextUsed || 0,
      contextMax: boxed.contextMax || 200000,
      selfTokens: boxed.selfTokens || 0,
      totalTokens: boxed.totalTokens || 0,
      counters: cloneCounters(boxed.counters)
    };
    this.agents.set(agentId, agent);
    this.lastUpdate = now;
    this.emit('update', this.snapshot());
    return true;
  }

  snapshot() {
    const now = Date.now();
    const agents = Array.from(this.agents.values())
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        displayName: agent.displayName || null,
        subagentType: agent.subagentType || null,
        projectId: agent.projectId,
        sessionId: agent.sessionId,
        parentId: agent.parentId,
        childrenIds: Array.from(agent.childrenIds),
        status: agent.status,
        activity: agent.activity,
        lastTool: agent.lastTool,
        lastCommand: agent.lastCommand || null,
        lastSeen: agent.lastSeen,
        createdAt: agent.createdAt,
        isActive: now - agent.lastSeen < this.activeTimeoutMs,
        isSleeping: now - agent.lastSeen >= this.activeTimeoutMs && now - agent.lastSeen < this.staleTimeoutMs,
        contextUsed: agent.contextUsed || 0,
        contextMax: agent.contextMax || 200000,
        selfTokens: agent.selfTokens || 0,
        totalTokens: agent.totalTokens || 0,
        lastUserQuery: agent.lastUserQuery || null,
        counters: cloneCounters(agent.counters)
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);

    return {
      now,
      lastUpdate: this.lastUpdate || now,
      activeTimeoutSec: Math.floor(this.activeTimeoutMs / 1000),
      staleTimeoutSec: Math.floor(this.staleTimeoutMs / 1000),
      activeAgentCount: agents.filter((agent) => agent.isActive).length,
      pokedex: this.pokedexSnapshot(),
      agents,
      recentEvents: this.recentEvents.slice(-80),
      boxedAgents: this.boxedAgents.slice(),
      subagentHistory: this.subagentHistory.slice()
    };
  }

  serialize() {
    const agents = [];
    for (const agent of this.agents.values()) {
      agents.push({
        agentId: agent.agentId,
        name: agent.name,
        displayName: agent.displayName || null,
        subagentType: agent.subagentType || null,
        projectId: agent.projectId,
        sessionId: agent.sessionId,
        parentId: agent.parentId || null,
        childrenIds: Array.from(agent.childrenIds),
        status: agent.status,
        activity: agent.activity,
        lastTool: agent.lastTool,
        lastCommand: agent.lastCommand || null,
        lastSeen: agent.lastSeen,
        createdAt: agent.createdAt,
        contextUsed: agent.contextUsed || 0,
        contextMax: agent.contextMax || 200000,
        selfTokens: agent.selfTokens || 0,
        totalTokens: agent.totalTokens || 0,
        lastUserQuery: agent.lastUserQuery || null,
        counters: cloneCounters(agent.counters)
      });
    }
    return {
      version: 1,
      savedAt: Date.now(),
      seenPokemonIds: Array.from(this.seenPokemonIds).sort((a, b) => a - b),
      firstDiscoveryByPokemon: { ...this.firstDiscoveryByPokemon },
      agents,
      boxedAgents: this.boxedAgents.slice(),
      subagentHistory: this.subagentHistory.slice()
    };
  }

  restore(data) {
    if (!data || data.version !== 1) return false;

    this.mergeSeenPokemonIds(data.seenPokemonIds, data.firstDiscoveryByPokemon);
    this.boxedAgents = Array.isArray(data.boxedAgents) ? data.boxedAgents : [];
    this.subagentHistory = Array.isArray(data.subagentHistory) ? data.subagentHistory : [];
    this.trimHistoryBuffers();

    if (Array.isArray(data.agents)) {
      for (const raw of data.agents) {
        const agent = cloneAgentRecord(raw);
        this.agents.set(agent.agentId, agent);
      }
    }

    this.refreshSeenPokemonFromAgents();
    this.lastUpdate = Date.now();
    return true;
  }

  reset(options = {}) {
    const now = Date.now();
    const preserveActiveRootAgents = options.preserveActiveRootAgents === true;
    const preservedAgents = preserveActiveRootAgents
      ? Array.from(this.agents.values())
        .filter((agent) =>
          !agent.parentId &&
          agent.status !== STATUS.SLEEPING &&
          now - (agent.lastSeen || 0) < this.activeTimeoutMs
        )
        .map((agent) => cloneAgentRecord(agent))
      : [];

    this.agents.clear();
    this.boxedAgents = [];
    this.subagentHistory = [];
    this.recentEvents = [];
    this.seenPokemonIds = new Set();
    this.firstDiscoveryByPokemon = {};
    this.lastUpdate = now;

    for (const agent of preservedAgents) {
      agent.childrenIds = new Set();
      if (agent.status === STATUS.SLEEPING) {
        agent.status = STATUS.THINKING;
        agent.activity = 'Active';
      }
      this.agents.set(agent.agentId, agent);
    }

    if (preservedAgents.length > 0) {
      this.refreshSeenPokemonFromAgents();
    }

    if (options.emit !== false) {
      this.emit('pokedex', this.pokedexSnapshot());
      this.emit('update', this.snapshot());
    }
  }
}

module.exports = {
  AgentState,
  STATUS
};
