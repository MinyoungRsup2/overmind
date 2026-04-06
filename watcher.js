'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { StringDecoder } = require('string_decoder');
const { normalizeLine } = require('./parser');

const DEFAULT_SCAN_INTERVAL_MS = 2500;
const DEFAULT_INITIAL_READ_BYTES = 128 * 1024;

class TranscriptWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rootPath = path.resolve(options.rootPath || path.join(os.homedir(), '.claude', 'projects'));
    this.scanIntervalMs = options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS;
    this.initialReadBytes = options.initialReadBytes || DEFAULT_INITIAL_READ_BYTES;
    this.staleTimeoutMs = options.staleTimeoutMs || 28800 * 1000;

    this.fileStates = new Map();
    this.fileWatchers = new Map();
    this.dirWatchers = new Map();
    this.scanTimer = null;
    this.scanQueued = false;
    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;

    await this.scanTree();
    this.scanTimer = setInterval(() => {
      this.scanTree().catch((error) => this.emit('warn', `scan failed: ${error.message}`));
    }, this.scanIntervalMs);
    this.scanTimer.unref();

    this.emit('info', `watching Claude transcripts under ${this.rootPath}`);
  }

  async stop() {
    if (!this.started) {
      return;
    }
    this.started = false;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    for (const watcher of this.dirWatchers.values()) {
      watcher.close();
    }

    this.fileWatchers.clear();
    this.dirWatchers.clear();
    this.fileStates.clear();
  }

  async resetToCurrentEnd() {
    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();
    this.fileStates.clear();

    if (!this.started) {
      return;
    }

    await this.scanTree({ readInitialTail: false });
  }

  queueScan(delayMs = 120) {
    if (this.scanQueued || !this.started) {
      return;
    }
    this.scanQueued = true;
    setTimeout(() => {
      this.scanQueued = false;
      this.scanTree().catch((error) => this.emit('warn', `queued scan failed: ${error.message}`));
    }, delayMs).unref();
  }

  async scanTree(options = {}) {
    let entries;
    try {
      entries = await this.walk(this.rootPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.emit('warn', `path does not exist yet: ${this.rootPath}`);
        return;
      }
      throw error;
    }

    const liveDirs = new Set();
    const liveFiles = new Set();

    for (const item of entries) {
      if (item.type === 'dir') {
        liveDirs.add(item.path);
        this.ensureDirWatcher(item.path);
      } else if (item.type === 'file' && item.path.toLowerCase().endsWith('.jsonl')) {
        liveFiles.add(item.path);
        await this.ensureFileTracked(item.path, options);
      }
    }

    for (const dirPath of this.dirWatchers.keys()) {
      if (!liveDirs.has(dirPath)) {
        const watcher = this.dirWatchers.get(dirPath);
        if (watcher) {
          watcher.close();
        }
        this.dirWatchers.delete(dirPath);
      }
    }

    for (const filePath of this.fileStates.keys()) {
      if (!liveFiles.has(filePath)) {
        this.fileStates.delete(filePath);
        const watcher = this.fileWatchers.get(filePath);
        if (watcher) {
          watcher.close();
        }
        this.fileWatchers.delete(filePath);
      }
    }
  }

  async walk(startPath) {
    const out = [];
    const stack = [path.resolve(startPath)];

    while (stack.length > 0) {
      const dirPath = stack.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(dirPath, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          continue;
        }
        throw error;
      }

      out.push({ type: 'dir', path: dirPath });
      for (const dirent of dirents) {
        const absPath = path.join(dirPath, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(absPath);
        } else if (dirent.isFile()) {
          out.push({ type: 'file', path: absPath });
        }
      }
    }

    return out;
  }

  ensureDirWatcher(dirPath) {
    if (this.dirWatchers.has(dirPath)) {
      return;
    }

    try {
      const watcher = fs.watch(dirPath, () => this.queueScan());
      watcher.on('error', (error) => {
        this.emit('warn', `dir watch error (${dirPath}): ${error.message}`);
        this.dirWatchers.delete(dirPath);
      });
      this.dirWatchers.set(dirPath, watcher);
    } catch (error) {
      this.emit('warn', `failed to watch dir ${dirPath}: ${error.message}`);
    }
  }

  async ensureFileTracked(filePath, options = {}) {
    if (!this.fileStates.has(filePath)) {
      // Skip files whose mtime is older than staleTimeout
      try {
        const stats = await fsp.stat(filePath);
        const age = Date.now() - stats.mtimeMs;
        if (age > this.staleTimeoutMs) {
          return;
        }
      } catch (error) {
        if (error.code === 'ENOENT') return;
        this.emit('warn', `stat failed (${filePath}): ${error.message}`);
        return;
      }

      const state = {
        position: 0,
        leftover: '',
        decoder: new StringDecoder('utf8'),
        reading: false,
        pending: false,
        agentMeta: null
      };

      // Read .meta.json for subagent files (contains description and agentType)
      if (filePath.toLowerCase().endsWith('.jsonl')) {
        const metaPath = filePath.replace(/\.jsonl$/i, '.meta.json');
        try {
          const raw = await fsp.readFile(metaPath, 'utf8');
          const meta = JSON.parse(raw);
          if (meta && typeof meta === 'object') {
            state.agentMeta = meta;
          }
        } catch (_ignore) {
          // .meta.json may not exist for main session files — that's fine
        }
      }

      this.fileStates.set(filePath, state);

      await this.primeFile(filePath, state, options);
      this.ensureFileWatcher(filePath);
    }

    await this.tailFile(filePath);
  }

  ensureFileWatcher(filePath) {
    if (this.fileWatchers.has(filePath)) {
      return;
    }

    try {
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'rename') {
          this.queueScan();
          return;
        }
        this.tailFile(filePath).catch((error) => {
          this.emit('warn', `tail failed (${filePath}): ${error.message}`);
        });
      });
      watcher.on('error', (error) => {
        this.emit('warn', `file watch error (${filePath}): ${error.message}`);
        this.fileWatchers.delete(filePath);
      });
      this.fileWatchers.set(filePath, watcher);
    } catch (error) {
      this.emit('warn', `failed to watch file ${filePath}: ${error.message}`);
    }
  }

  async primeFile(filePath, state, options = {}) {
    const readInitialTail = options.readInitialTail !== false;
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('warn', `stat failed (${filePath}): ${error.message}`);
      }
      return;
    }

    // Scan file head for the first user message to derive a session display name.
    // This is separate from the tail read so large files don't miss their first entry.
    const HEAD_BYTES = 16 * 1024;
    if (stats.size > 0) {
      await this.scanHeadForUserEntry(filePath, state, Math.min(HEAD_BYTES, stats.size));
    }

    if (!readInitialTail) {
      state.position = stats.size;
      state.leftover = '';
      state.decoder = new StringDecoder('utf8');
      return;
    }

    const bytesToRead = Math.min(this.initialReadBytes, stats.size);
    state.position = Math.max(0, stats.size - bytesToRead);

    if (bytesToRead === 0) {
      return;
    }

    await this.readNewBytes(filePath, state, true);
  }

  async scanHeadForUserEntry(filePath, state, bytes) {
    let fd;
    try {
      fd = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await fd.read(buffer, 0, bytes, 0);
      const text = buffer.toString('utf8', 0, bytesRead);
      const lines = text.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const events = normalizeLine(line, {
          filePath,
          configuredRoot: this.rootPath,
          agentMeta: state.agentMeta || null
        });

        for (const event of events) {
          if (event.meta && event.meta.sessionDisplayName) {
            this.emit('event', event);
            return;
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('warn', `head scan failed (${filePath}): ${error.message}`);
      }
    } finally {
      if (fd) await fd.close();
    }
  }

  async tailFile(filePath) {
    const state = this.fileStates.get(filePath);
    if (!state) {
      return;
    }

    if (state.reading) {
      state.pending = true;
      return;
    }

    state.reading = true;
    try {
      await this.readNewBytes(filePath, state, false);
    } finally {
      state.reading = false;
      if (state.pending) {
        state.pending = false;
        await this.tailFile(filePath);
      }
    }
  }

  async readNewBytes(filePath, state, isPrime) {
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('warn', `stat failed (${filePath}): ${error.message}`);
      }
      return;
    }

    if (stats.size < state.position) {
      state.position = 0;
      state.leftover = '';
      state.decoder = new StringDecoder('utf8');
    }

    if (stats.size === state.position) {
      return;
    }

    const start = state.position;
    const end = stats.size;
    const length = end - start;

    let fd;
    try {
      fd = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(length);
      let bytesReadTotal = 0;

      while (bytesReadTotal < length) {
        const { bytesRead } = await fd.read(
          buffer,
          bytesReadTotal,
          length - bytesReadTotal,
          start + bytesReadTotal
        );
        if (bytesRead <= 0) {
          break;
        }
        bytesReadTotal += bytesRead;
      }

      state.position = start + bytesReadTotal;

      const text = state.leftover + state.decoder.write(buffer.subarray(0, bytesReadTotal));
      const lines = text.split(/\r?\n/);
      state.leftover = lines.pop() || '';

      const outEvents = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const normalizedEvents = normalizeLine(line, {
          filePath,
          configuredRoot: this.rootPath,
          agentMeta: state.agentMeta || null
        });

        for (const event of normalizedEvents) {
          outEvents.push(event);
          this.emit('event', event);
        }
      }

      if (outEvents.length > 0) {
        this.emit('events', outEvents);
      } else if (!isPrime && lines.length > 0) {
        this.emit('debug', `read ${lines.length} lines with no recognized events from ${filePath}`);
      }
    } catch (error) {
      this.emit('warn', `read failed (${filePath}): ${error.message}`);
    } finally {
      if (fd) {
        await fd.close();
      }
    }
  }
}

module.exports = {
  TranscriptWatcher
};
