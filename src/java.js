/**
 * Java Edition bot backed by mineflayer + mineflayer-pathfinder.
 *
 * The controller owns the session; this class only knows how to drive a single
 * Java connection and reports state back through the `emit` callback.
 *
 * Cracked (offline-mode) servers ask for `/register` or `/login`; the bot
 * answers automatically from a per-server password stored under data/.
 */

import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const { pathfinder, Movements, goals } = pf;

const CHAT_LIMIT = 200;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomPassword() {
  return `0kay-${randomBytes(5).toString('hex')}`;
}

export class JavaBot {
  constructor(emit) {
    this.emit = emit;
    this.bot = null;
    this.state = 'idle';
    this.lastError = '';
    this.chatLog = [];
    this.options = {};
    this.authHandled = false;
    this.authGenerated = false;
    this.authAttempts = 0;
    this.authenticated = false;
    this.credentialsPath = process.env.MINECRAFT_CREDENTIALS
      || path.join(process.env.MINECRAFT_DATA_DIR || './data', 'credentials.json');
    this.credentials = {};
  }

  describe() {
    const bot = this.bot;
    const pos = bot?.entity?.position;
    return {
      edition: 'java',
      state: this.state,
      error: this.lastError,
      username: this.options.username || '',
      host: this.options.host || '',
      port: this.options.port || 25565,
      version: bot?.version || this.options.version || '',
      connected: this.state === 'connected',
      position: pos ? { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) } : null,
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      dimension: bot?.game?.dimension || '',
      players: this.playerList(),
      held: bot?.heldItem?.name || null,
      inventory: this.inventorySummary(),
    };
  }

  inventorySummary() {
    const bot = this.bot;
    if (!bot) return [];
    try {
      return bot.inventory.items().map((item) => ({ name: item.name, count: item.count, slot: item.slot }));
    } catch {
      return [];
    }
  }

  async connect(opts = {}) {
    await this.disconnect();
    this.options = {
      host: opts.host || process.env.MINECRAFT_HOST || '127.0.0.1',
      port: Number(opts.port) || Number(process.env.MINECRAFT_JAVA_PORT) || 25565,
      username: opts.username || process.env.MINECRAFT_USERNAME || '0kay_bot',
      version: opts.version || process.env.MINECRAFT_VERSION || undefined,
      auth: opts.auth === 'microsoft' ? 'microsoft' : 'offline',
      password: opts.password || opts.server_password || process.env.MINECRAFT_SERVER_PASSWORD || '',
      microsoftPassword: opts.microsoft_password || process.env.MINECRAFT_PASSWORD || undefined,
    };
    this.authHandled = false;
    this.authGenerated = false;
    this.authAttempts = 0;
    this.authenticated = false;
    this.lastError = '';
    this.state = 'connecting';
    this.credentials = await this.#loadCredentials();
    const key = `${this.options.host}:${this.options.port}`;
    if (!this.options.password && this.credentials[key]?.password) {
      this.options.password = this.credentials[key].password;
    }
    this.emit('log', `java: connecting to ${this.options.host}:${this.options.port} as ${this.options.username} (${this.options.auth})`);

    this.bot = mineflayer.createBot({
      host: this.options.host,
      port: this.options.port,
      username: this.options.username,
      version: this.options.version,
      auth: this.options.auth,
      password: this.options.auth === 'microsoft' ? this.options.microsoftPassword : undefined,
      hideErrors: true,
    });

    this.bot.loadPlugin(pathfinder);
    this.#wire(this.bot);
    await this.#waitForSettle();
    const result = { accepted: true, edition: 'java', ...this.describe() };
    if (this.authGenerated) result.generated_password = this.options.password;
    return result;
  }

  #wire(bot) {
    bot.once('spawn', () => {
      this.state = 'connected';
      try {
        const movements = new Movements(bot);
        // Default: never modify the world while walking (no digging/bridging).
        movements.canDig = false;
        movements.allow1by1towers = false;
        bot.pathfinder.setMovements(movements);
      } catch (error) {
        this.emit('log', `java: pathfinder init failed: ${error.message}`);
      }
      this.emit('state', this.describe());
      this.emit('log', 'java: spawned');
    });
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.#pushChat(username, message);
    });
    bot.on('message', (jsonMsg) => {
      const text = jsonMsg?.toString?.() || '';
      if (!text) return;
      this.#pushChat('', text, true);
      this.#handleAuthPrompt(text);
    });
    bot.on('playerJoined', (player) => this.emit('log', `java: ${player.username} joined`));
    bot.on('playerLeft', (player) => this.emit('log', `java: ${player.username} left`));
    bot.on('kicked', (reason) => this.#fail(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    bot.on('error', (error) => this.#fail(error.message));
    bot.on('end', (reason) => {
      this.#pushChat('', `bot disconnected (${reason})`);
      if (this.state !== 'error') this.state = 'idle';
      this.emit('state', this.describe());
    });
  }

  #handleAuthPrompt(text) {
    if (!this.bot) return;
    const lower = text.toLowerCase();
    if (this.authenticated && !/密码错误|密码不正确|wrong password|incorrect password|invalid password/.test(lower)) return;

    if (/注册成功|登录成功|successfully (logged in|registered)|logged in|欢迎回来|加入了游戏|welcome back|欢迎/.test(lower)) {
      this.authenticated = true;
      this.authAttempts = 0;
      this.authHandled = true;
      this.emit('log', 'java: authenticated with the server');
      return;
    }
    if (/已注册|已被注册|already registered/.test(lower)) {
      this.#sendLogin('already registered');
      return;
    }
    if (/密码错误|密码不正确|wrong password|incorrect password|invalid password/.test(lower)) {
      this.authAttempts += 1;
      this.emit('log', `java: server rejected the password (attempt ${this.authAttempts})`);
      return;
    }

    const wantsRegister = /\/register\b|\bregister\b|注册/.test(lower);
    const wantsLogin = /\/login\b|\blogin\b|登录|登陆/.test(lower);

    if (wantsLogin && this.options.password) { this.#sendLogin('login prompt'); return; }
    if (wantsRegister) {
      if (!this.options.password) {
        this.options.password = randomPassword();
        this.authGenerated = true;
        void this.#saveCredentials();
      }
      if (this.authAttempts >= 4) return;
      this.authAttempts += 1;
      this.authHandled = true;
      this.bot.chat(`/register ${this.options.password} ${this.options.password}`);
      this.emit('log', `java: sent /register (${this.authGenerated ? 'generated' : 'configured'} password, attempt ${this.authAttempts})`);
      void this.#saveCredentials();
      return;
    }
    if (wantsLogin && !this.options.password) {
      this.emit('log', 'java: server requires /login but no password is configured');
    }
  }

  #sendLogin(reason) {
    if (!this.bot) return;
    if (!this.options.password) {
      this.emit('log', `java: /login required (${reason}) but no password is configured`);
      return;
    }
    if (this.authAttempts >= 4) return;
    this.authAttempts += 1;
    this.authHandled = true;
    this.bot.chat(`/login ${this.options.password}`);
    this.emit('log', `java: sent /login (${reason}, attempt ${this.authAttempts})`);
  }

  async #loadCredentials() {
    try {
      return JSON.parse(await fs.readFile(this.credentialsPath, 'utf8'));
    } catch {
      return {};
    }
  }

  async #saveCredentials() {
    if (!this.options.password) return;
    const key = `${this.options.host}:${this.options.port}`;
    this.credentials[key] = { username: this.options.username, password: this.options.password };
    try {
      await fs.mkdir(path.dirname(this.credentialsPath), { recursive: true });
      await fs.writeFile(this.credentialsPath, JSON.stringify(this.credentials, null, 2), 'utf8');
    } catch (error) {
      this.emit('log', `java: could not persist credentials: ${error.message}`);
    }
  }

  async #waitForSettle(timeoutMs = 18000) {
    const deadline = Date.now() + timeoutMs;
    let connectedAt = 0;
    while (Date.now() < deadline) {
      if (this.state === 'error') return;
      if (this.state === 'connected') {
        if (!connectedAt) connectedAt = Date.now();
        if (Date.now() - connectedAt > 3500) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  #pushChat(username, message, raw = false) {
    const entry = { time: new Date().toISOString(), username, message, raw };
    this.chatLog.push(entry);
    if (this.chatLog.length > CHAT_LIMIT) this.chatLog.splice(0, this.chatLog.length - CHAT_LIMIT);
    this.emit('chat', entry);
  }

  #fail(message) {
    this.lastError = message;
    this.state = 'error';
    this.emit('log', `java: ${message}`);
    this.emit('state', this.describe());
  }

  playerList() {
    const bot = this.bot;
    if (!bot) return [];
    return Object.values(bot.players || {}).map((player) => ({
      name: player.username,
      uuid: player.uuid || '',
      ping: player.ping ?? null,
      gamemode: player.gamemode ?? null,
      position: player.entity?.position
        ? { x: +player.entity.position.x.toFixed(1), y: +player.entity.position.y.toFixed(1), z: +player.entity.position.z.toFixed(1) }
        : null,
    }));
  }

  entityByName(name) {
    const bot = this.bot;
    if (!bot) return null;
    const target = String(name || '').toLowerCase();
    if (!target) return null;
    if (target === 'nearest') {
      const me = bot.entity?.position;
      let best = null;
      let bestDist = Infinity;
      for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity === bot.entity) continue;
        const kind = entity.type || entity.kind;
        if (kind !== 'player' && kind !== 'mob' && kind !== 'hostile' && kind !== 'animal' && kind !== 'passive') continue;
        const dist = me ? me.distanceTo(entity.position) : 0;
        if (dist < bestDist) { bestDist = dist; best = entity; }
      }
      return best;
    }
    const player = bot.players?.[name];
    if (player?.entity) return player.entity;
    for (const entity of Object.values(bot.entities || {})) {
      if ((entity.username || entity.name || '').toLowerCase() === target) return entity;
    }
    return null;
  }

  requireReady() {
    if (!this.bot || this.state !== 'connected') throw new Error(`java bot not connected (${this.state}${this.lastError ? `: ${this.lastError}` : ''})`);
    return this.bot;
  }

  async chat(message) {
    const bot = this.requireReady();
    const text = String(message || '').slice(0, 250);
    if (!text) throw new Error('message is required');
    bot.chat(text);
    return { sent: true, message: text };
  }

  async follow(name, distance = 3) {
    const bot = this.requireReady();
    const entity = this.entityByName(name);
    if (!entity) throw new Error(`entity not found: ${name}`);
    const range = clamp(Number(distance) || 3, 1, 16);
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true);
    return { following: name, distance: range };
  }

  async goto(x, y, z, allowDig = false) {
    const bot = this.requireReady();
    try { if (bot.pathfinder.movements) bot.pathfinder.movements.canDig = !!allowDig; } catch { /* ignore */ }
    const goal = new goals.GoalBlock(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
    bot.pathfinder.setGoal(goal);
    return { goingTo: { x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) }, allowDig: !!allowDig };
  }

  async stop() {
    const bot = this.requireReady();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return { stopped: true };
  }

  async lookAt(target) {
    const bot = this.requireReady();
    if (typeof target === 'object' && target !== null) {
      await bot.lookAt(new Vec3(Number(target.x), Number(target.y), Number(target.z)), true);
      return { lookingAt: target };
    }
    const entity = this.entityByName(target);
    if (!entity) throw new Error(`entity not found: ${target}`);
    await bot.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.9 : 1.6, 0), true);
    return { lookingAt: target };
  }

  async dig(x, y, z) {
    const bot = this.requireReady();
    const block = bot.blockAt(new Vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z))));
    if (!block || block.name === 'air') throw new Error('no block at target position');
    await bot.dig(block, true);
    return { dug: block.name, position: { x: block.position.x, y: block.position.y, z: block.position.z } };
  }

  async place(x, y, z, item) {
    const bot = this.requireReady();
    const target = new Vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
    if (item) {
      const stack = bot.inventory.items().find((entry) => entry.name.includes(String(item)));
      if (!stack) throw new Error(`item not in inventory: ${item}`);
      await bot.equip(stack, 'hand');
    }
    const reference = bot.blockAt(target.offset(0, -1, 0)) || bot.blockAt(target.offset(1, 0, 0));
    if (!reference || reference.name === 'air') throw new Error('no adjacent block to place against');
    const face = target.minus(reference.position);
    await bot.placeBlock(reference, face);
    return { placed: item || bot.heldItem?.name || 'block', position: { x: target.x, y: target.y, z: target.z } };
  }

  async attack(target) {
    const bot = this.requireReady();
    if (target === 'nearest' || !target) {
      const entity = this.entityByName('nearest');
      if (!entity) throw new Error('no nearby entity');
      bot.attack(entity);
      return { attacked: entity.name || entity.username || entity.type || 'entity' };
    }
    const entity = this.entityByName(target);
    if (!entity) throw new Error(`entity not found: ${target}`);
    bot.attack(entity);
    return { attacked: target };
  }

  async inventory() {
    const bot = this.requireReady();
    const items = bot.inventory.items().map((item) => ({ name: item.name, count: item.count, slot: item.slot }));
    return { held: bot.heldItem?.name || null, items };
  }

  /** Perception: nearby blocks matching name fragments (mirrors Numen's scan_blocks). */
  async scanBlocks(args = {}) {
    const bot = this.requireReady();
    const names = (Array.isArray(args.names) ? args.names : [args.name || args.block || ''])
      .map((value) => String(value || '').toLowerCase().trim())
      .filter(Boolean);
    const radius = clamp(Number(args.radius) || 16, 1, 64);
    const count = clamp(Number(args.count) || 8, 1, 32);
    const origin = bot.entity?.position;
    const matching = names.length
      ? (block) => names.some((name) => block?.name === name || (block?.name || '').includes(name))
      : (block) => !!block && block.name !== 'air';
    const blocks = bot.findBlocks({ matching, maxDistance: radius, count }).map((pos) => {
      const block = bot.blockAt(pos);
      const distance = origin ? +origin.distanceTo(pos).toFixed(1) : null;
      return { name: block?.name || 'unknown', x: pos.x, y: pos.y, z: pos.z, distance };
    });
    if (!blocks.length) {
      return { blocks: [], hint: names.length ? `附近 ${radius} 格内没找到 ${names.join('/')}` : `附近 ${radius} 格内没有可交互方块` };
    }
    blocks.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    return { blocks };
  }

  /** Perception: nearby entities with distance (mirrors Numen's scan_nearby_entities). */
  async scanEntities(args = {}) {
    const bot = this.requireReady();
    const radius = clamp(Number(args.radius) || 24, 1, 64);
    const origin = bot.entity?.position;
    const entities = [];
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || entity === bot.entity || !entity.position) continue;
      const distance = origin ? +origin.distanceTo(entity.position).toFixed(1) : null;
      if (distance != null && distance > radius) continue;
      entities.push({
        name: entity.name || entity.username || entity.displayName || entity.type || 'entity',
        type: entity.type || '',
        distance,
        x: +entity.position.x.toFixed(1),
        y: +entity.position.y.toFixed(1),
        z: +entity.position.z.toFixed(1),
      });
    }
    entities.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
    return { entities: entities.slice(0, 24) };
  }

  async use(item) {
    const bot = this.requireReady();
    if (item) {
      const stack = bot.inventory.items().find((entry) => entry.name.includes(String(item)));
      if (!stack) throw new Error(`item not in inventory: ${item}`);
      await bot.equip(stack, 'hand');
    }
    await bot.activateItem();
    return { used: item || bot.heldItem?.name || 'held item' };
  }

  /** Block name at a position (for consent checks). */
  blockNameAt(x, y, z) {
    const bot = this.requireReady();
    const block = bot.blockAt(new Vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z))));
    return block?.name || 'air';
  }

  /** Info about a named entity (for consent checks). */
  entityInfo(name) {
    const entity = this.entityByName(name);
    if (!entity) return null;
    return { name: entity.name || entity.username || entity.displayName || entity.type || '', type: entity.type || '', username: entity.username || '' };
  }

  /**
   * Egocentric semantic grid: a compact map of block "short codes" around the
   * bot (feet + eye level). Follows Numen's idea of giving the model a spatial
   * picture instead of a bare coordinate list.
   */
  async scanGrid(args = {}) {
    const bot = this.requireReady();
    const radius = clamp(Number(args.radius) || 4, 2, 6);
    const origin = bot.entity?.position;
    if (!origin) throw new Error('position unknown');
    const cx = Math.floor(origin.x);
    const cy = Math.floor(origin.y);
    const cz = Math.floor(origin.z);
    const names = new Map();
    const short = (name) => {
      if (!name || name === 'air') return '..';
      if (!names.has(name)) {
        const parts = name.split('_');
        const code = parts.length === 1 ? name.slice(0, 2) : parts.map((p) => p[0]).join('').slice(0, 3);
        names.set(name, code);
      }
      return names.get(name);
    };
    const layers = [];
    for (const dy of [0, 1]) {
      const rows = [];
      for (let dz = -radius; dz <= radius; dz++) {
        const cells = [];
        for (let dx = -radius; dx <= radius; dx++) cells.push(short(bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz))?.name));
        rows.push(cells.join(' '));
      }
      layers.push({ dy, rows });
    }
    return {
      self: { x: cx, y: cy, z: cz },
      radius,
      legend: Object.fromEntries([...names.entries()].map(([name, code]) => [code, name])),
      layers,
      note: 'rows go from north(-z) to south(+z); columns west(-x) to east(+x); ".."=air. dy=0 feet, dy=1 eye.',
    };
  }

  /**
   * Plan (without moving) up to three candidate routes to a target, each with a
   * "price tag": how many blocks must be dug and how many placed. Mirrors
   * Numen's "list candidate routes with price tags, don't change the world".
   */
  async planRoute(args = {}) {
    const bot = this.requireReady();
    const tx = Math.floor(Number(args.x));
    const ty = Math.floor(Number(args.y));
    const tz = Math.floor(Number(args.z));
    if (![tx, ty, tz].every(Number.isFinite)) throw new Error('x, y, z are required');
    const origin = bot.entity?.position;
    if (!origin) throw new Error('position unknown');
    const ox = Math.floor(origin.x); const oy = Math.floor(origin.y); const oz = Math.floor(origin.z);
    const sample = (y) => {
      let dig = 0; let place = 0;
      const steps = Math.max(Math.abs(tx - ox), Math.abs(tz - oz), 1);
      for (let i = 0; i <= steps; i++) {
        const x = Math.round(ox + ((tx - ox) * i) / steps);
        const z = Math.round(oz + ((tz - oz) * i) / steps);
        const feet = bot.blockAt(new Vec3(x, y, z));
        const head = bot.blockAt(new Vec3(x, y + 1, z));
        const ground = bot.blockAt(new Vec3(x, y - 1, z));
        if (feet && feet.name !== 'air') dig++;
        if (head && head.name !== 'air') dig++;
        if (!ground || ground.name === 'air') place++;
      }
      return { dig, place };
    };
    const candidates = [
      { id: 'route-current-y', y: oy, note: '沿当前高度直走', ...sample(oy) },
      { id: 'route-target-y', y: ty, note: '先到目标高度再直走', ...sample(ty) },
      { id: 'route-step', y: Math.min(oy, ty), note: '按较低高度走，再上下', ...sample(Math.min(oy, ty)) },
    ];
    return { target: { x: tx, y: ty, z: tz }, candidates, note: 'dig/place 是该路线大概需要挖/放的方块数；走路默认不改世界，要挖请 goto 时带 allow_dig。' };
  }

  async disconnect() {
    const bot = this.bot;
    this.bot = null;
    this.state = 'idle';
    if (bot) {
      try { bot.quit('0kay disconnect'); } catch { /* ignore */ }
      try { bot.end(); } catch { /* ignore */ }
    }
    return { disconnected: true };
  }
}
