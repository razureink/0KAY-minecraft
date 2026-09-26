/**
 * BotController owns the live session and exposes a single action surface that
 * the HTTP API and the autopilot both call. Exactly one connection is kept at a
 * time; switching edition or reconnecting disposes the previous bot cleanly.
 *
 * It also owns persistent world knowledge (waypoints + reusable skills) so the
 * bot can learn a server over time.
 */

import * as path from 'path';
import { JavaBot } from './java.js';
import { BedrockBot } from './bedrock.js';
import { WorldStore } from './world.js';

const CHAT_LIMIT = 200;

// Long-running actions become background tasks (task_id + events) when the
// caller asks for it, so the brain can keep thinking while the body works.
const LONG_ACTIONS = new Set(['goto', 'follow', 'dig', 'place', 'attack', 'use', 'skill_run', 'waypoint_goto', 'goto_route']);

// Breaking one of these (block entities / containers / player stations) or
// hitting one of these mobs needs the owner's consent.
const BLOCK_ENTITY_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker', 'hopper',
  'dispenser', 'dropper', 'ender_chest', 'shulker_box', 'beacon', 'spawner', 'jukebox',
  'lectern', 'crafting_table', 'anvil', 'enchanting_table', 'brewing_stand', 'campfire', 'bed',
]);
const PROTECTED_ENTITY = /villager|wandering_trader|wolf|cat|ocelot|parrot|horse|donkey|mule|llama|axolotl|allay|snow_golem|fox|bee|panda|turtle|camel|frog|goat|strider|iron_golem/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BotController {
  constructor({ coreUrl = 'http://127.0.0.1:8080' } = {}) {
    this.coreUrl = coreUrl;
    this.bot = null;
    this.edition = null;
    this.chat = [];
    this.logs = [];
    this.listeners = new Set();
    this.autopilot = null;
    this.lastAction = null;
    this.events = [];
    this.eventSeq = 0;
    this.tasks = new Map();
    this.taskSeq = 0;
    this.runningTaskId = null;
    this.consentSeq = 0;
    this.pendingConsent = null;
    this.consentMode = String(process.env.MINECRAFT_CONSENT || 'ask').toLowerCase();
    this.routePlan = null;
    const dataDir = process.env.MINECRAFT_DATA_DIR || './data';
    this.world = new WorldStore(path.join(dataDir, 'world.json'));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, data) {
    if (type === 'chat') {
      this.chat.push(data);
      if (this.chat.length > CHAT_LIMIT) this.chat.splice(0, this.chat.length - CHAT_LIMIT);
    }
    if (type === 'log') {
      this.logs.push({ time: new Date().toISOString(), message: data });
      if (this.logs.length > CHAT_LIMIT) this.logs.splice(0, this.logs.length - CHAT_LIMIT);
    }
    const event = { seq: ++this.eventSeq, time: new Date().toISOString(), type, data };
    this.events.push(event);
    if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
    for (const listener of this.listeners) {
      try { listener(type, data); } catch { /* listener errors must not break the bot */ }
    }
  }

  eventsSince(since = 0) {
    const cursor = Number(since) || 0;
    return this.events.filter((event) => event.seq > cursor);
  }

  serverKey() {
    const opts = this.bot?.options || {};
    if (!opts.host) return 'default';
    const port = opts.port || (this.edition === 'bedrock' ? 19132 : 25565);
    return `${opts.host}:${port}`;
  }

  async connect(args = {}) {
    const edition = String(args.edition || process.env.MINECRAFT_EDITION || 'java').toLowerCase() === 'bedrock' ? 'bedrock' : 'java';
    await this.#dispose();
    this.edition = edition;
    this.bot = edition === 'bedrock' ? new BedrockBot((t, d) => this.emit(t, d)) : new JavaBot((t, d) => this.emit(t, d));
    this.emit('log', `controller: connecting ${edition}`);
    const result = await this.bot.connect(args);
    await this.captureWorld();
    return { ...result, ...(await this.status()) };
  }

  async #dispose() {
    if (this.autopilot?.running) this.autopilot.stop('reconnect');
    const bot = this.bot;
    this.bot = null;
    if (bot) {
      try { await bot.disconnect(); } catch { /* ignore */ }
    }
  }

  get connected() {
    return this.bot?.state === 'connected';
  }

  requireBot() {
    if (!this.bot) throw new Error('no bot session (call connect first)');
    return this.bot;
  }

  /** Remember where the bot and other players are, so locations survive restarts. */
  async captureWorld() {
    if (!this.bot || this.bot.state !== 'connected') return;
    const key = this.serverKey();
    const info = this.bot.describe();
    if (info.position) {
      await this.world.addWaypoint(key, { id: 'self', name: 'self', x: info.position.x, y: info.position.y, z: info.position.z, dimension: info.dimension, type: 'position', note: 'last position' }).catch(() => {});
    }
    for (const player of info.players || []) {
      if (player.name === info.username || !player.position) continue;
      await this.world.addWaypoint(key, { id: `player-${player.name}`, name: player.name, x: player.position.x, y: player.position.y, z: player.position.z, dimension: info.dimension, type: 'player', note: 'last seen' }).catch(() => {});
    }
  }

  async worldSnapshot() {
    await this.world.ready;
    const key = this.serverKey();
    const [waypoints, skills, markdown] = await Promise.all([
      this.world.listWaypoints(key),
      this.world.listSkills(key),
      this.world.markdownSkills(),
    ]);
    return { server: key, waypoints, skills, markdown };
  }

  async status() {
    const bot = this.bot ? this.bot.describe() : null;
    const key = this.serverKey();
    const [waypoints, skills] = await Promise.all([this.world.listWaypoints(key), this.world.listSkills(key)]);
    return {
      edition: this.edition,
      bot,
      autopilot: this.autopilot ? this.autopilot.status() : { running: false },
      tasks: this.taskStatus(),
      consent: this.consentStatus(),
      recentChat: this.chat.slice(-20),
      coreUrl: this.coreUrl,
      world: { server: key, waypoints: waypoints.length, skills: skills.length },
    };
  }

  async runSkill(id, depth = 0) {
    const key = this.serverKey();
    const skill = await this.world.getSkill(key, id);
    if (!skill) throw new Error(`skill not found: ${id}`);
    if (depth > 0) throw new Error('skill_run cannot be nested');
    const results = [];
    for (const step of skill.steps) {
      if (step.action === 'skill_run') throw new Error('skill_run cannot be nested');
      await this.action(step.action, step.args || {});
      results.push(step.action);
      const wait = Number(step.waitMs);
      if (Number.isFinite(wait) && wait > 0) await sleep(Math.min(wait, 10000));
    }
    await this.world.markSkillRun(key, id);
    return { skill: id, steps: results.length, results };
  }

  consentStatus() {
    return {
      mode: this.consentMode,
      pending: this.pendingConsent
        ? { id: this.pendingConsent.id, action: this.pendingConsent.action, detail: this.pendingConsent.detail, created_at: this.pendingConsent.created_at }
        : null,
    };
  }

  consentReply(id, approve) {
    const pending = this.pendingConsent;
    if (!pending || (id && id !== pending.id)) return { resolved: false };
    this.pendingConsent = null;
    clearTimeout(pending.timer);
    pending.resolve(!!approve);
    return { resolved: true, id: pending.id, approved: !!approve };
  }

  #needsConsent(name, args) {
    if (this.consentMode === 'allow') return null;
    try {
      if (name === 'dig') {
        const block = this.bot?.blockNameAt?.(args.x, args.y, args.z);
        if (block && /chest|furnace|door|bed|shulker|barrel|hopper|dispenser|beacon|spawner|crafting_table|anvil|enchanting|brewing/.test(block)) {
          return `挖掉 ${block}（可能是箱子/设施）`;
        }
      } else if (name === 'place') {
        const at = this.bot?.blockNameAt?.(args.x, args.y, args.z);
        if (at && at !== 'air' && !/water|grass|snow|tall_grass|flower|air/.test(at)) return `在 ${at} 上放置方块`;
      } else if (name === 'attack') {
        const info = this.bot?.entityInfo?.(args.target || args.player || 'nearest');
        if (info && PROTECTED_ENTITY.test(info.name || info.type || '')) return `攻击 ${info.name || info.type}`;
      }
    } catch { /* never block on a classification error */ }
    return null;
  }

  async #requestConsent(action, detail) {
    if (this.consentMode === 'allow') return true;
    if (this.consentMode === 'deny') return false;
    if (this.pendingConsent) return false; // one ask at a time
    const id = `consent_${++this.consentSeq}`;
    const payload = { id, action, detail, created_at: new Date().toISOString() };
    this.emit('consent_request', payload);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingConsent?.id === id) {
          this.pendingConsent = null;
          this.emit('consent_timeout', payload);
          resolve(false);
        }
      }, 60000);
      this.pendingConsent = { ...payload, resolve, timer };
    });
  }

  // --- background tasks (Numen-style: long jobs run in the background) -------
  taskStatus(id) {
    if (id) {
      const task = this.tasks.get(String(id));
      return task ? { ...task } : { error: `unknown task: ${id}` };
    }
    return { running: this.runningTaskId ? { ...this.tasks.get(this.runningTaskId) } : null, recent: [...this.tasks.values()].slice(-8) };
  }

  taskStop(id) {
    const task = id ? this.tasks.get(String(id)) : this.tasks.get(this.runningTaskId);
    if (!task || task.status !== 'running') return { stopped: false };
    task.cancel = true;
    try { this.bot?.stop?.(); } catch { /* ignore */ }
    return { stopped: true, task_id: task.id };
  }

  async dispatch(name, args = {}, options = {}) {
    if (options.background && LONG_ACTIONS.has(name)) {
      if (this.runningTaskId) {
        const running = this.tasks.get(this.runningTaskId);
        return { refused: true, reason: `busy: task ${this.runningTaskId} (${running?.action}) is running`, task_id: this.runningTaskId };
      }
      const id = `task_${++this.taskSeq}`;
      const task = { id, action: name, args, status: 'running', started_at: new Date().toISOString(), cancel: false };
      this.tasks.set(id, task);
      this.runningTaskId = id;
      this.emit('task_started', { task_id: id, action: name, args });
      this.action(name, args)
        .then((result) => {
          task.status = task.cancel ? 'cancelled' : 'done';
          task.result = result;
          this.emit('task_finished', { task_id: id, action: name, status: task.status, result });
        })
        .catch((error) => {
          task.status = 'failed';
          task.error = error.message;
          this.emit('task_finished', { task_id: id, action: name, status: 'failed', error: error.message });
        })
        .finally(() => { if (this.runningTaskId === id) this.runningTaskId = null; });
      return { task_id: id, status: 'running' };
    }
    return await this.action(name, args);
  }

  async action(name, args = {}) {
    if (name === 'task_status') return this.taskStatus(args.id);
    if (name === 'task_stop') return this.taskStop(args.id);
    if (name === 'consent_reply') return this.consentReply(args.id, args.approve);
    if (name === 'consent_status') return this.consentStatus();
    if (LONG_ACTIONS.has(name)) {
      const detail = this.#needsConsent(name, args);
      if (detail && !(await this.#requestConsent(name, detail))) {
        return { refused: true, reason: `owner declined: ${detail}` };
      }
    }
    this.lastAction = { name, args, time: new Date().toISOString() };
    const key = this.serverKey();
    switch (name) {
      case 'connect': return this.connect(args);
      case 'disconnect': await this.#dispose(); this.edition = null; return { disconnected: true };
      case 'chat': return this.requireBot().chat(args.message ?? args.text);
      case 'follow': return this.requireBot().follow(args.player ?? args.target, args.distance);
      case 'goto': return this.requireBot().goto(args.x, args.y, args.z, !!args.allow_dig);
      case 'stop': return this.requireBot().stop();
      case 'look': return this.requireBot().lookAt(args.target || args.player || args);
      case 'dig': return this.requireBot().dig(args.x, args.y, args.z);
      case 'place': return this.requireBot().place(args.x, args.y, args.z, args.item);
      case 'attack': return this.requireBot().attack(args.target || args.player);
      case 'inventory': return this.requireBot().inventory();
      case 'use': return this.requireBot().use(args.item);
      case 'players': return { players: this.bot ? this.bot.playerList?.() ?? this.bot.describe().players : [] };
      case 'scan_blocks': return this.requireBot().scanBlocks(args);
      case 'scan_entities': return this.requireBot().scanEntities(args);
      case 'scan_grid': return this.requireBot().scanGrid(args);
      case 'plan_route': {
        const plan = await this.requireBot().planRoute(args);
        this.routePlan = { ...plan, at: new Date().toISOString() };
        return plan;
      }
      case 'goto_route': {
        const plan = this.routePlan;
        let waypoints = Array.isArray(args.waypoints) ? args.waypoints : null;
        if (!waypoints && plan?.candidates?.length) {
          const candidate = plan.candidates.find((c) => c.id === (args.id || plan.candidates[0].id)) || plan.candidates[0];
          waypoints = candidate.waypoints;
        }
        if (!waypoints || !waypoints.length) throw new Error('no route: call plan_route first or pass waypoints');
        const bot = this.requireBot();
        const reached = [];
        for (const wp of waypoints) {
          await bot.gotoAndWait(wp.x, wp.y, wp.z, !!args.allow_dig, Number(args.timeout_ms) || Number(args.timeoutMs) || 30000);
          reached.push({ x: wp.x, y: wp.y, z: wp.z });
        }
        return { reached, waypoints };
      }
      case 'skill_read': {
        const wanted = args.id || args.name;
        const md = await this.world.markdownSkill(wanted);
        if (md) return md;
        const skill = await this.world.getSkill(key, wanted);
        if (!skill) throw new Error(`skill not found: ${wanted}`);
        return skill;
      }
      case 'events': return { cursor: this.eventSeq, events: this.eventsSince(args.since) };
      case 'status': return this.status();
      case 'world': return this.worldSnapshot();
      case 'waypoint_add': return this.world.addWaypoint(key, args);
      case 'waypoint_list': return { waypoints: await this.world.listWaypoints(key) };
      case 'waypoint_remove': return { removed: await this.world.removeWaypoint(key, args.id || args.name) };
      case 'waypoint_goto': {
        const wp = await this.world.findWaypoint(key, args.id || args.name);
        if (!wp) throw new Error(`waypoint not found: ${args.id || args.name}`);
        return this.requireBot().goto(wp.x, wp.y, wp.z);
      }
      case 'skill_save': return this.world.saveSkill(key, args);
      case 'skill_list': {
        const native = (await this.world.listSkills(key)).map(({ steps, ...rest }) => ({ ...rest, steps: steps.length, kind: 'steps' }));
        const md = (await this.world.markdownSkills()).map(({ body, ...rest }) => ({ ...rest, kind: 'markdown' }));
        return { skills: [...native, ...md] };
      }
      case 'skill_remove': return { removed: await this.world.removeSkill(key, args.id || args.name) };
      case 'skill_run': return this.runSkill(args.id || args.name);
      default: throw new Error(`unknown action: ${name}`);
    }
  }
}
