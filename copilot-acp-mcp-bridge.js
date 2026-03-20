#!/usr/bin/env node
// copilot-acp-mcp-bridge
//
// Exposes GitHub Copilot CLI as an MCP tool (stdio) for Codex or any MCP client.
// Internally, it drives Copilot through its ACP server (copilot --acp --stdio).
//
// Main tool: ask_copilot(prompt, context?, freshSession?, allowTools?, model?)
//   - persistent session by default (context is retained across calls)
//   - freshSession:true  : disposable isolated ACP session, destroyed after the call
//   - context            : text prepended to the ACP session/prompt payload
//   - allowTools:false   : hard block, every ACP session/request_permission
//                          receives cancelled regardless of permissionPolicy
//
// Diagnostic tools: copilot_session_status, copilot_reset_session
// Transport: JSON-RPC 2.0 NDJSON over stdio (MCP client side, ACP Copilot side)
'use strict';

const { spawn } = require('child_process');
const readline  = require('readline');
const path      = require('path');
const fs        = require('fs');

const BRIDGE_NAME = 'copilot-acp-mcp-bridge';
const BRIDGE_VERSION = process.env.COPILOT_ACP_BRIDGE_VERSION || '0.2.1';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const ACP_PROTOCOL_VERSION = 1;

const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS   = -32602;
const E_INTERNAL         = -32603;

// ─── Declared schema for ask_copilot ─────────────────────────────────────────
// Any argument outside this list -> error -32602.

const ASK_COPILOT_KNOWN_ARGS = new Set([
  'prompt', 'context', 'freshSession', 'allowTools', 'model',
]);

// ─── Config ───────────────────────────────────────────────────────────────────

const bridgeCwdEnv = process.env.COPILOT_ACP_BRIDGE_CWD || process.env.CHAIRMAN_CWD || process.cwd();

const CONFIG = {
  copilotBin:                 process.env.COPILOT_BIN || 'copilot',
  copilotArgs:                parseJsonArray('COPILOT_ARGS_JSON', []),
  bridgeCwd:                  path.resolve(bridgeCwdEnv),
  startupTimeoutMs:           parsePositiveInt(process.env.STARTUP_TIMEOUT_MS, 15_000),
  promptTimeoutMs:            parsePositiveInt(process.env.PROMPT_TIMEOUT_MS, 300_000),
  cancelGraceMs:              parsePositiveInt(process.env.CANCEL_GRACE_MS, 10_000),
  permissionPolicy:           process.env.PERMISSION_POLICY || 'first',
  preferredPermissionOptionId:process.env.PREFERRED_PERMISSION_OPTION_ID || '',
  autoAuthMethodId:           process.env.AUTO_AUTH_METHOD_ID || '',
  eagerStart:                 parseBool(process.env.EAGER_START, false),
  includeTelemetryInOutput:   parseBool(process.env.INCLUDE_TELEMETRY_IN_OUTPUT, true),
  includeUsageInOutput:       parseBool(process.env.INCLUDE_USAGE_IN_OUTPUT, true),
  logLevel:                   process.env.LOG_LEVEL || 'info',
  sessionConfigOptions:       parseOptionalJsonObject('ACP_SESSION_CONFIG_OPTIONS_JSON'),
  sessionModes:               parseOptionalJsonObject('ACP_SESSION_MODES_JSON'),
  mcpServers:                 loadAcpMcpServers(),
};

// ─── Utilities ───────────────────────────────────────────────────────────────

let _seq = 1;
const nextId = () => _seq++;

function parseBool(v, fb) {
  if (v == null || v === '') return fb;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function parsePositiveInt(v, fb) {
  if (v == null || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb;
}
function parseJsonArray(name, fb) {
  const raw = process.env[name];
  if (!raw) return fb;
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : fb; }
  catch { return fb; }
}
function parseOptionalJsonObject(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch { return null; }
}
function extractConfiguredModelFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--model') {
      const next = args[i + 1];
      if (next == null) return null;
      return String(next);
    }
    if (arg.startsWith('--model=')) return arg.slice('--model='.length) || null;
  }
  return null;
}
function withConfiguredModel(args, model) {
  const next = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--model') { i++; continue; }
    if (arg.startsWith('--model=')) continue;
    next.push(args[i]);
  }
  if (model) next.push('--model', model);
  return next;
}
function loadAcpMcpServers() {
  const raw  = process.env.COPILOT_ACP_MCP_SERVERS_JSON;
  const file = process.env.COPILOT_ACP_MCP_SERVERS_FILE;
  if (raw)  {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch (e) {
      log('warn', `COPILOT_ACP_MCP_SERVERS_JSON invalid: ${e.message}`);
      return [];
    }
  }
  if (file) {
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(p) ? p : [];
    } catch (e) {
      log('warn', `COPILOT_ACP_MCP_SERVERS_FILE invalid or unreadable: ${e.message}`);
      return [];
    }
  }
  return [];
}

const CONFIGURED_MODEL_FROM_ENV = extractConfiguredModelFromArgs(CONFIG.copilotArgs);

const LOG_ORDER = { error:0, warn:1, info:2, debug:3 };
function log(level, msg, extra) {
  const cur = LOG_ORDER[CONFIG.logLevel] ?? 2;
  const inc = LOG_ORDER[level] ?? 2;
  if (inc > cur) return;
  const sfx = extra == null ? '' : ' ' + safeJson(extra);
  process.stderr.write(`[bridge:${level}] ${msg}${sfx}\n`);
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function writeNdjson(s, obj) { s.write(JSON.stringify(obj) + '\n'); }
function trunc(s, n=160) { const c = String(s||'').replace(/\s+/g,' ').trim(); return c.length<=n ? c : c.slice(0,n-3)+'...'; }
function makeError(msg, data) { const e=new Error(msg); if(data) e.data=data; return e; }
function isAuthError(e) {
  if (!e) return false;
  const code = e.code ?? e.data?.code;
  const reason = e.reason ?? e.data?.reason;
  const m = String(e.message||'').toLowerCase();
  return reason === 'auth_required' || code === -32000 || code === -32001 || m.includes('auth');
}

// ─── ACP text assembly ───────────────────────────────────────────────────────
//
// context + allowTools=false -> system preamble
// then the user prompt

function buildAcpText({ prompt, context, allowTools }) {
  const parts = [];

  if (allowTools === false) {
    parts.push('System constraints:\n- Do not use any tools, MCP servers, or function calls.\n- Answer only from the supplied context or your own knowledge.');
  }

  if (context && typeof context === 'string' && context.trim()) {
    parts.push(`Context:\n${context.trim()}`);
  }

  parts.push(`Task:\n${prompt.trim()}`);
  return parts.join('\n\n');
}

// ─── DeferredQueue ────────────────────────────────────────────────────────────

class DeferredQueue {
  constructor() { this._tail = Promise.resolve(); }
  run(fn) {
    const p = this._tail.then(() => fn());
    this._tail = p.catch(() => undefined);
    return p;
  }
}

// ─── AcpSession ──────────────────────────────────────────────────────────────
//
// Encapsulates one ACP session (one Copilot process + one sessionId).
// Used either in persistent mode (reused) or disposable mode
// (created and destroyed per call).

class AcpSession {
  constructor(config, progressSink, options = {}) {
    this.config         = config;
    this.progressSink   = progressSink;
    this.configuredModel = options.configuredModel ?? extractConfiguredModelFromArgs(config.copilotArgs);
    this.modelSource    = options.modelSource || (this.configuredModel ? 'env:copilot_args_json' : 'default');
    this.proc           = null;
    this.rl             = null;
    this.sessionId      = null;
    this.sessionStartedAt = null;
    this.agentInfo      = null;
    this.agentCapabilities = null;
    this.authMethods    = [];
    this.pendingRequests = new Map();
    this.activePrompt   = null;
    this.promptCount    = 0;
    this.started        = false;
    this.shuttingDown   = false;
  }

  async start() {
    this.shuttingDown = false;
    const args = ['--acp', '--stdio', ...withConfiguredModel(this.config.copilotArgs, this.configuredModel)];
    log('info', `spawning ${this.config.copilotBin} ${args.join(' ')}`);

    this.proc = spawn(this.config.copilotBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.bridgeCwd,
      env: process.env,
    });

    this.proc.on('error', e => log('error', `copilot process error: ${e.message}`));
    this.proc.stderr.on('data', d => { const t=String(d||'').trim(); if(t) log('debug',`copilot:stderr: ${t}`); });
    this.proc.on('exit', (code, sig) => {
      log(this.shuttingDown ? 'info' : 'warn', `copilot exited code=${code} signal=${sig}`);
      this.started = false;
      this.sessionId = null;
      const pending = [...this.pendingRequests.values()];
      this.pendingRequests.clear();
      for (const e of pending) { clearTimeout(e.timer); e.reject(makeError(`Copilot exited (code=${code})`)); }
      if (this.activePrompt && !this.shuttingDown) this.activePrompt.bridgeExit = true;
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', line => this._onLine(line.trim()));

    await this._handshake();
    this.started = true;
  }

  async _handshake() {
    const init = await this._request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'codex-copilot-acp-mcp-bridge', version: BRIDGE_VERSION },
    }, this.config.startupTimeoutMs);

    this.agentInfo         = init.agentInfo || null;
    this.agentCapabilities = init.agentCapabilities || null;
    this.authMethods       = Array.isArray(init.authMethods) ? init.authMethods : [];
    log('info', 'ACP initialized', { protocolVersion: init.protocolVersion, agentInfo: this.agentInfo });

    await this._createSession();
  }

  async _createSession() {
    try {
      const s = await this._request('session/new', this._sessionNewParams(), this.config.startupTimeoutMs);
      this.sessionId = s.sessionId;
      this.sessionStartedAt = new Date().toISOString();
      log('info', `ACP session created ${this.sessionId}`);
    } catch (err) {
      if (!isAuthError(err.data || err)) throw err;
      if (!this.config.autoAuthMethodId) {
        throw makeError('Copilot requires authentication. Run `copilot login`.', { authMethods: this.authMethods });
      }
      const found = this.authMethods.find(m => (m.methodId||m.id) === this.config.autoAuthMethodId);
      if (!found) throw makeError(`AUTO_AUTH_METHOD_ID=${this.config.autoAuthMethodId} not advertised`, { authMethods: this.authMethods });
      await this._request('authenticate', { methodId: this.config.autoAuthMethodId }, this.config.startupTimeoutMs);
      const s = await this._request('session/new', this._sessionNewParams(), this.config.startupTimeoutMs);
      this.sessionId = s.sessionId;
      this.sessionStartedAt = new Date().toISOString();
      log('info', `ACP session created after auth ${this.sessionId}`);
    }
  }

  _sessionNewParams() {
    const p = { cwd: this.config.bridgeCwd, mcpServers: this.config.mcpServers };
    if (this.config.sessionConfigOptions) p.configOptions = this.config.sessionConfigOptions;
    if (this.config.sessionModes) p.modes = this.config.sessionModes;
    return p;
  }

  // ── Prompt ────────────────────────────────────────────────────────────────

  async runPrompt(mcpRequestId, text, meta = {}) {
    const op = {
      mcpRequestId,
      acpRequestId: nextId(),
      progressToken:      meta.progressToken,
      requestedModel:     meta.requestedModel,
      // allowTools=false makes _onPermission always return cancelled,
      // regardless of permissionPolicy.
      allowTools:         meta.allowTools,
      text,
      createdAt:          Date.now(),
      cancelled:          false,
      timedOut:           false,
      bridgeExit:         false,
      updateCount:        0,
      textChunks:         [],
      toolCalls:          new Map(),
      plan:               null,
      usage:              null,
      otherUpdates:       [],
      pendingPermissionIds: new Set(),
    };

    this.activePrompt = op;
    this.promptCount++;
    this.progressSink.start(op, 'sent');

    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (op.timedOut) return;
          op.timedOut = true;
          log('warn', `prompt timeout, cancelling ${mcpRequestId}`);
          this.cancelPrompt(mcpRequestId, 'timeout');

          const pending = this.pendingRequests.get(op.acpRequestId);
          if (pending) {
            this.pendingRequests.delete(op.acpRequestId);
            pending.reject(makeError(`ACP prompt timed out after ${this.config.promptTimeoutMs}ms`, { reason: 'timeout' }));
          } else {
            reject(makeError(`ACP prompt timed out after ${this.config.promptTimeoutMs}ms`, { reason: 'timeout' }));
          }
        }, this.config.promptTimeoutMs);

        this.pendingRequests.set(op.acpRequestId, {
          method: 'session/prompt', timer,
          resolve: r => { clearTimeout(timer); resolve(r); },
          reject:  e => { clearTimeout(timer); reject(e); },
        });

        writeNdjson(this.proc.stdin, {
          jsonrpc: '2.0', id: op.acpRequestId, method: 'session/prompt',
          params: { sessionId: this.sessionId, prompt: [{ type:'text', text }] },
        });

        this.progressSink.emit(op, 'session/prompt sent');
      });

      const stopReason = result?.stopReason || 'end_turn';
      this.progressSink.finish(op, stopReason);
      return this._buildPayload(op, stopReason);

    } catch (err) {
      if (op.timedOut) {
        this.progressSink.finish(op, 'timeout');
        throw err;
      }
      if (op.cancelled) {
        this.progressSink.finish(op, 'cancelled');
        return this._buildPayload(op, 'cancelled');
      }
      if (op.bridgeExit) throw makeError('Copilot process exited during prompt');
      throw err;
    } finally {
      this.activePrompt = null;
    }
  }

  // ── ACP input handling ────────────────────────────────────────────────────

  _onLine(line) {
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { log('warn', `invalid ACP line: ${trunc(line,300)}`); return; }

    if (msg.method === 'session/update')            { this._onUpdate(msg.params||{}); return; }
    if (msg.method === 'session/request_permission') { this._onPermission(msg);       return; }

    if (msg.id != null) {
      const p = this.pendingRequests.get(msg.id);
      if (!p) { log('debug', `unexpected ACP response id=${msg.id}`); return; }
      this.pendingRequests.delete(msg.id);
      if (msg.error) p.reject(makeError(`ACP ${p.method} failed: ${msg.error.message||'unknown'}`, msg.error));
      else           p.resolve(msg.result);
    }
  }

  _onUpdate(params) {
    const update = params.update;
    if (!update) return;
    const op = this.activePrompt;
    if (!op) return;
    if (params.sessionId && this.sessionId && params.sessionId !== this.sessionId) {
      log('warn', `ignoring update for unexpected session ${params.sessionId}`); return;
    }
    op.updateCount++;
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
      op.textChunks.push(update.content.text||'');
      this.progressSink.emit(op, `chunk: ${trunc(update.content.text,60)}`);
      return;
    }
    if (kind === 'tool_call') {
      const ex = op.toolCalls.get(update.toolCallId)||{};
      op.toolCalls.set(update.toolCallId, { toolCallId:update.toolCallId, kind:update.kind||ex.kind||null, status:update.status||ex.status||'pending', title:update.title||ex.title||null, content:ex.content||null });
      this.progressSink.emit(op, `tool_call: ${update.title||update.toolCallId}`);
      return;
    }
    if (kind === 'tool_call_update') {
      const ex = op.toolCalls.get(update.toolCallId)||{ toolCallId:update.toolCallId };
      op.toolCalls.set(update.toolCallId, { ...ex, kind:update.kind||ex.kind||null, status:update.status||ex.status||null, title:update.title||ex.title||null, content:update.content!==undefined?update.content:ex.content });
      this.progressSink.emit(op, `tool_call_update: ${update.toolCallId} ${update.status||''}`.trim());
      return;
    }
    if (kind === 'plan') {
      op.plan = Array.isArray(update.entries) ? update.entries : [];
      this.progressSink.emit(op, `plan: ${op.plan.length} entries`);
      return;
    }
    if (kind === 'usage_update') {
      op.usage = { ...(op.usage||{}), ...update };
      return;
    }
    op.otherUpdates.push(update);
    this.progressSink.emit(op, kind||'unknown_update');
  }

  _onPermission(msg) {
    const op = this.activePrompt;
    if (!op) { this._replyPerm(msg.id, { outcome:'cancelled' }); return; }
    op.pendingPermissionIds.add(msg.id);

    // Cancel if the prompt was already cancelled.
    if (op.cancelled) {
      this._replyPerm(msg.id, { outcome:'cancelled' });
      op.pendingPermissionIds.delete(msg.id);
      return;
    }

    // ── Hard block: allowTools:false rejects every permission request ───────
    // The bridge returns cancelled regardless of permissionPolicy.
    // The text injection in buildAcpText is only guidance to the model;
    // this block is the actual guardrail.
    if (op.allowTools === false) {
      log('info', `permission cancelled: allowTools=false (tool: ${msg.params?.toolName || 'unknown'})`);
      this._replyPerm(msg.id, { outcome:'cancelled' });
      op.pendingPermissionIds.delete(msg.id);
      return;
    }

    const opts = Array.isArray(msg.params?.options) ? msg.params.options : [];
    const sel  = this._selectOption(opts);
    if (!sel) {
      log('info', 'permission cancelled (no matching option)');
      this._replyPerm(msg.id, { outcome:'cancelled' });
    } else {
      log('info', `permission selected optionId="${sel.optionId}" (${sel.name||''})`);
      this._replyPerm(msg.id, { outcome:'selected', optionId:sel.optionId });
    }
    op.pendingPermissionIds.delete(msg.id);
  }

  _selectOption(opts) {
    if (!opts.length) return null;
    if (this.config.permissionPolicy === 'cancel') return null;
    if (this.config.preferredPermissionOptionId) {
      const ex = opts.find(o => o.optionId === this.config.preferredPermissionOptionId);
      if (ex) return ex;
    }
    if (this.config.permissionPolicy === 'prefer-allow') {
      const a = opts.find(o => /allow|approve/i.test(String(o.kind||'')+String(o.name||'')));
      if (a) return a;
    }
    return opts[0];
  }

  _replyPerm(id, outcome) {
    if (!this.proc?.stdin) return;
    writeNdjson(this.proc.stdin, { jsonrpc:'2.0', id, result:{ outcome } });
  }

  cancelPrompt(mcpRequestId, reason) {
    const op = this.activePrompt;
    if (!op || op.mcpRequestId !== mcpRequestId || op.cancelled) return !!op?.cancelled;
    op.cancelled = true;
    this.progressSink.emit(op, `cancelling: ${reason||'cancelled'}`);
    for (const pid of op.pendingPermissionIds) this._replyPerm(pid, { outcome:'cancelled' });
    op.pendingPermissionIds.clear();
    if (this.proc?.stdin && !this.proc.killed)
      writeNdjson(this.proc.stdin, { jsonrpc:'2.0', method:'session/cancel', params:{ sessionId:this.sessionId } });
    return true;
  }

  // ── Generic request ───────────────────────────────────────────────────────

  _request(method, params, timeoutMs) {
    if (!this.proc?.stdin) return Promise.reject(makeError('ACP process not available'));
    return new Promise((resolve, reject) => {
      const id = nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(makeError(`ACP request "${method}" timed out`));
      }, timeoutMs);
      this.pendingRequests.set(id, { method, timer,
        resolve: r => { clearTimeout(timer); resolve(r); },
        reject:  e => { clearTimeout(timer); reject(e); },
      });
      writeNdjson(this.proc.stdin, { jsonrpc:'2.0', id, method, params });
    });
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  async stop() {
    this.shuttingDown = true;

    const proc = this.proc;
    try { this.rl?.close(); } catch {}
    this.rl = null;

    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const entry of pending) {
      try { clearTimeout(entry.timer); } catch {}
      try { entry.reject(makeError('ACP session stopped')); } catch {}
    }

    if (this.activePrompt) {
      for (const pid of this.activePrompt.pendingPermissionIds) {
        this._replyPerm(pid, { outcome:'cancelled' });
      }
      this.activePrompt.pendingPermissionIds.clear();
    }

    if (proc && !proc.killed) {
      await new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const guard = setTimeout(finish, this.config.cancelGraceMs);
        try {
          proc.once('exit', () => {
            clearTimeout(guard);
            finish();
          });
          proc.kill('SIGTERM');
        } catch {
          clearTimeout(guard);
          finish();
        }
      });
    }

    this.proc = null;
    this.started = false;
    this.sessionId = null;
    this.sessionStartedAt = null;
    this.activePrompt = null;
  }

  // ── MCP payload ───────────────────────────────────────────────────────────

  _buildPayload(op, stopReason) {
    const text     = op.textChunks.join('');
    const toolCalls = [...op.toolCalls.values()];
    const parts    = [];

    if (text.trim()) parts.push(text.trim());
    else             parts.push(`[Copilot stopReason=${stopReason}]`);

    if (this.config.includeTelemetryInOutput) {
      parts.push('', '---');
      parts.push(`stopReason: ${stopReason}`);
      parts.push(`sessionId: ${this.sessionId}`);
      parts.push(`configuredModel: ${this.configuredModel || 'default'}`);
      parts.push(`modelSource: ${this.modelSource}`);
      if (op.requestedModel) parts.push(`requestedModel: ${op.requestedModel}`);
      parts.push(`updates: ${op.updateCount}`);

      if (toolCalls.length > 0) {
        parts.push('tool_calls:');
        for (const tc of toolCalls) {
          const detail = tc.content ? ` → ${trunc(safeJson(tc.content),300)}` : '';
          parts.push(`- [${tc.status||'?'}] ${tc.title||tc.toolCallId}${detail}`);
        }
      }
      if (op.plan?.length) {
        parts.push('plan:');
        for (const e of op.plan) parts.push(`- [${e.status||'?'}] ${e.content}`);
      }
      if (this.config.includeUsageInOutput && op.usage) {
        parts.push('usage:');
        for (const [k,v] of Object.entries(op.usage)) {
          if (k === 'sessionUpdate') continue;
          parts.push(`- ${k}: ${safeJson(v)}`);
        }
      }
      if (op.otherUpdates.length) parts.push(`other_updates: ${op.otherUpdates.length}`);
    }

    return { content: [{ type:'text', text: parts.join('\n').trim() }] };
  }

  getStatus() {
    const now = Date.now();
    return {
      started:           this.started,
      sessionId:         this.sessionId,
      sessionStartedAt:  this.sessionStartedAt,
      sessionAgeMs:      this.sessionStartedAt ? now - new Date(this.sessionStartedAt).getTime() : null,
      promptCount:       this.promptCount,
      agentInfo:         this.agentInfo,
      authMethods:       this.authMethods,
      configuredModel:   this.configuredModel,
      modelSource:       this.modelSource,
      bridgeCwd:         this.config.bridgeCwd,
      mcpServersCount:   this.config.mcpServers.length,
      activePrompt:      this.activePrompt ? {
        mcpRequestId: this.activePrompt.mcpRequestId,
        createdAt:    new Date(this.activePrompt.createdAt).toISOString(),
        cancelled:    this.activePrompt.cancelled,
        updates:      this.activePrompt.updateCount,
      } : null,
    };
  }
}

// ─── ProgressSink ─────────────────────────────────────────────────────────────

class ProgressSink {
  constructor(send) { this.send = send; this.seq = new Map(); }
  start(op, msg)  { this._emit(op, msg); }
  emit(op, msg)   { this._emit(op, msg); }
  finish(op, msg) { this._emit(op, `done: ${msg}`); if (op?.progressToken != null) this.seq.delete(op.progressToken); }
  _emit(op, msg) {
    if (!op || op.progressToken == null) return;
    const n = (this.seq.get(op.progressToken)||0)+1;
    this.seq.set(op.progressToken, n);
    this.send({ jsonrpc:'2.0', method:'notifications/progress',
      params:{ progressToken:op.progressToken, progress:n, message:msg } });
  }
}

// ─── McpServer ────────────────────────────────────────────────────────────────

class McpServer {
  constructor(config) {
    this.config       = config;
    this.rl           = readline.createInterface({ input: process.stdin });
    this.progressSink = new ProgressSink(msg => this._send(msg));

    // Persistent session (lazy start by default).
    this.persistentConfiguredModel = CONFIGURED_MODEL_FROM_ENV;
    this.persistentModelSource = this.persistentConfiguredModel ? 'env:copilot_args_json' : 'default';
    this.persistent   = new AcpSession(config, this.progressSink, {
      configuredModel: this.persistentConfiguredModel,
      modelSource: this.persistentModelSource,
    });
    this.persistQueue = new DeferredQueue();

    // Map mcpRequestId -> AcpSession for active fresh sessions.
    // Used to route notifications/cancelled to the correct session.
    this.freshSessions = new Map();

    this.initialized  = false;

    this.rl.on('line', line => this._onLine(line.trim()));
    process.stdin.on('end', async () => {
      await this.stopAll('stdin closed');
      process.exit(0);
    });
  }

  async maybeEagerStart() {
    if (this.config.eagerStart) await this._ensurePersistent();
  }

  async stopAll(reason = 'shutdown') {
    log('info', `stopping MCP server: ${reason}`);
    try { this.rl?.close(); } catch {}
    this.rl = null;

    const fresh = [...this.freshSessions.values()];
    this.freshSessions.clear();
    await Promise.allSettled(fresh.map(session => {
      if (session && typeof session.stop === 'function') return session.stop();
      return Promise.resolve();
    }));

    await this.persistent.stop();
  }

  _refreshPersistentSession() {
    this.persistent = new AcpSession(this.config, this.progressSink, {
      configuredModel: this.persistentConfiguredModel,
      modelSource: this.persistentModelSource,
    });
  }

  _resolveRequestedModel(rawModel) {
    if (rawModel == null) return undefined;
    if (typeof rawModel !== 'string') {
      throw makeError('Invalid argument "model": expected a string', {
        reason: 'invalid_model_type',
        requestedModelType: typeof rawModel,
      });
    }
    const model = rawModel.trim();
    if (!model) {
      throw makeError('Invalid argument "model": expected a non-empty string', {
        reason: 'invalid_model_value',
      });
    }
    return model;
  }

  _preparePersistentModel(requestedModel) {
    if (!requestedModel) return null;
    const conflictMessage = `Persistent session configured with model "${this.persistentConfiguredModel || 'default'}"; requested "${requestedModel}". Reset the session or use freshSession:true.`;

    if (this.persistent.started && this.persistent.sessionId) {
      if (this.persistentConfiguredModel === requestedModel) return null;
      throw makeError(
        conflictMessage,
        {
          reason: 'persistent_model_conflict',
          configuredModel: this.persistentConfiguredModel || null,
          requestedModel,
        },
      );
    }

    if (this.persistentConfiguredModel == null) {
      this.persistentConfiguredModel = requestedModel;
      this.persistentModelSource = 'ask_copilot:first_persistent_call';
      this._refreshPersistentSession();
      return null;
    }

    if (this.persistentConfiguredModel === requestedModel) return null;

    throw makeError(
      conflictMessage,
      {
        reason: 'persistent_model_conflict',
        configuredModel: this.persistentConfiguredModel,
        requestedModel,
      },
    );
  }

  async _ensurePersistent() {
    if (this.persistent.started && this.persistent.sessionId) return;
    await this.persistent.start();
  }

  _send(obj)        { process.stdout.write(JSON.stringify(obj)+'\n'); }
  _reply(id, r)     { this._send({ jsonrpc:'2.0', id, result:r }); }
  _error(id, c, m, d) { this._send({ jsonrpc:'2.0', id, error:{ code:c, message:m, ...(d?{data:d}:{}) } }); }

  _onLine(line) {
    if (!line) return;
    let req;
    try { req = JSON.parse(line); }
    catch { log('warn',`invalid MCP line: ${trunc(line,300)}`); return; }
    this._handle(req).catch(err => {
      log('error', `MCP handler: ${err.message}`);
      if (req.id != null) this._error(req.id, E_INTERNAL, err.message, err.data);
    });
  }

  async _handle(req) {
    const { id, method, params } = req;
    switch (method) {

      case 'initialize':
        this.initialized = true;
        this._reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools:{} },
          serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
        });
        return;

      case 'ping':
        this._reply(id, {});
        return;

      case 'notifications/initialized':
        return;

      case 'notifications/cancelled': {
        const reqId  = params?.requestId;
        const reason = params?.reason || 'cancelled';

        // Try the persistent session first.
        let cancelled = this.persistent.cancelPrompt(reqId, reason);

        // Then the active fresh sessions.
        if (!cancelled) {
          const fresh = this.freshSessions.get(reqId);
          if (fresh) cancelled = fresh.cancelPrompt(reqId, reason);
        }

        log('info', `MCP cancel requestId=${reqId} routed=${cancelled}`);
        return;
      }

      case 'tools/list':
        this._reply(id, { tools: [
          {
            name: 'ask_copilot',
            description: [
              'Send a task to GitHub Copilot via ACP.',
              'By default uses a persistent session (context retained across calls).',
              'Set freshSession:true for an isolated, stateless call.',
              'model configures the Copilot process used for the call or session; it is not a per-prompt ACP model switch.',
              'Use context to inject system or background information.',
              'Set allowTools:false to hard-block all tool use: every ACP session/request_permission is answered with cancelled, regardless of permissionPolicy.',
            ].join(' '),
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                prompt:       { type:'string',  description:'Task or question for Copilot.' },
                context:      { type:'string',  description:'Optional system/background context prepended to the prompt.' },
                freshSession: { type:'boolean', description:'If true, spawn a fresh Copilot process for this call only. Default: false.' },
                allowTools:   { type:'boolean', description:'If false, hard-block all tool use: every ACP session/request_permission is answered with cancelled, regardless of permissionPolicy. Default: true.' },
                model:        { type:'string',  description:'Optional Copilot CLI model name. Applies at the process/session level. In persistent mode the first configured model is kept until reset.' },
              },
              required: ['prompt'],
            },
          },
          {
            name: 'copilot_session_status',
            description: 'Return bridge and ACP session diagnostics: sessionId, age, promptCount, agentInfo, persistentConfiguredModel, modelSource.',
            inputSchema: { type:'object', additionalProperties:false, properties:{} },
          },
          {
            name: 'copilot_reset_session',
            description: 'Kill the persistent Copilot process and reset the session. The next ask_copilot call starts fresh.',
            inputSchema: {
              type:'object', additionalProperties:false,
              properties: { reason:{ type:'string', description:'Optional log note.' } },
            },
          },
        ]});
        return;

      case 'tools/call':
        await this._toolCall(id, params||{});
        return;

      default:
        if (id != null) this._error(id, E_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async _toolCall(id, params) {
    const name = params.name;

    // ── copilot_session_status ────────────────────────────────────────────────

    if (name === 'copilot_session_status') {
      const status = this.persistent.getStatus();
      status.persistentConfiguredModel = status.configuredModel;
      delete status.configuredModel;
      this._reply(id, { content:[{ type:'text', text: JSON.stringify(status, null, 2) }] });
      return;
    }

    // ── copilot_reset_session ─────────────────────────────────────────────────

    if (name === 'copilot_reset_session') {
      const reason = params.arguments?.reason || '';
      if (reason) log('info', `reset requested: ${reason}`);
      await this.persistent.stop();
      this.persistentConfiguredModel = CONFIGURED_MODEL_FROM_ENV;
      this.persistentModelSource = this.persistentConfiguredModel ? 'env:copilot_args_json' : 'default';
      this._refreshPersistentSession();
      this._reply(id, { content:[{ type:'text', text:'Copilot ACP session reset.' }] });
      return;
    }

    // ── ask_copilot ────────────────────────────────────────────────────────────

    if (name !== 'ask_copilot') {
      this._error(id, E_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      return;
    }

    const args = params.arguments || {};

    // Reject any undeclared argument.
    const unknown = Object.keys(args).filter(k => !ASK_COPILOT_KNOWN_ARGS.has(k));
    if (unknown.length > 0) {
      this._error(id, E_INVALID_PARAMS, `Unknown argument(s) for ask_copilot: ${unknown.join(', ')}. Allowed: ${[...ASK_COPILOT_KNOWN_ARGS].join(', ')}`);
      return;
    }

    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      this._error(id, E_INVALID_PARAMS, 'Missing required argument: prompt');
      return;
    }

    const context      = typeof args.context === 'string' ? args.context : undefined;
    const freshSession = args.freshSession === true;
    const allowTools   = args.allowTools !== false; // default true
    let requestedModel;
    try {
      requestedModel = this._resolveRequestedModel(args.model);
    } catch (err) {
      this._error(id, E_INVALID_PARAMS, err.message, err.data);
      return;
    }

    const text = buildAcpText({ prompt, context, allowTools });
    const progressToken = params._meta?.progressToken;

    log('info', `ask_copilot id=${id} fresh=${freshSession} allowTools=${allowTools} model=${requestedModel || this.persistentConfiguredModel || 'default'}: ${trunc(prompt,100)}`);

    if (freshSession) {
      // ── Disposable session ────────────────────────────────────────────────
      // Register early so notifications/cancelled can target it.
      // It is removed again in the finally block.
      const session = new AcpSession(this.config, this.progressSink, {
        configuredModel: requestedModel ?? CONFIGURED_MODEL_FROM_ENV,
        modelSource: requestedModel ? 'ask_copilot:fresh_session' : (CONFIGURED_MODEL_FROM_ENV ? 'env:copilot_args_json' : 'default'),
      });

      // Handles the case where cancelled arrives before the session is ready.
      let cancelledBeforeStart = false;

      // Handle the edge case where cancellation arrives very early.
      this.freshSessions.set(id, {
        cancelPrompt: (reqId, reason) => {
          if (session.activePrompt) return session.cancelPrompt(reqId, reason);
          // Session not started yet: remember the cancellation.
          cancelledBeforeStart = true;
          return true;
        },
        stop: async () => {
          cancelledBeforeStart = true;
        },
      });

      try {
        await session.start();

        // If cancellation arrives during startup, stop cleanly.
        if (cancelledBeforeStart) {
          log('info', `fresh session ${id} cancelled before start`);
          this._reply(id, { content:[{ type:'text', text:'[cancelled before start]' }] });
          return;
        }

        // Replace the proxy with the real session once it is ready.
        this.freshSessions.set(id, session);

        const result = await session.runPrompt(id, text, { progressToken, allowTools, requestedModel });
        this._reply(id, result);
      } finally {
        this.freshSessions.delete(id);
        await session.stop();
      }
    } else {
      // Serialized persistent session.
      let result;
      try {
        result = await this.persistQueue.run(async () => {
          this._preparePersistentModel(requestedModel);
          await this._ensurePersistent();
          return this.persistent.runPrompt(id, text, { progressToken, allowTools, requestedModel });
        });
      } catch (err) {
        if (err?.data?.reason === 'persistent_model_conflict') {
          this._error(id, E_INVALID_PARAMS, err.message, err.data);
          return;
        }
        throw err;
      }
      this._reply(id, result);
    }
  }
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

async function main() {
  log('info', `${BRIDGE_NAME} v${BRIDGE_VERSION}  cwd=${CONFIG.bridgeCwd}`);
  const server = new McpServer(CONFIG);
  await server.maybeEagerStart();
  log('info', 'bridge ready');
  const shutdown = async sig => {
    log('info', `received ${sig}, shutting down`);
    await server.stopAll(sig);
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  process.stderr.write(`[bridge:error] fatal: ${err.message}\n`);
  process.exit(1);
});
