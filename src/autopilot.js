/**
 * Autopilot: a stateful, goal-driven decision loop that lets the local model
 * play Minecraft through the controller.
 *
 * Unlike a stateless "one LLM call per tick" loop, this planner keeps:
 *   - a current goal (and a small goal stack the model can push/pop),
 *   - a rolling history of decisions and their outcomes,
 *   - a failure memory so it stops repeating actions that just keep failing,
 *   - an observation window that includes health/food, held item, inventory,
 *     nearest players, recent chat and the last action result.
 *
 * Each tick it renders that state into a compact prompt, asks Core's model
 * gateway for a single JSON decision, validates it against the actions allowed
 * for the current edition, executes it, and records the outcome. Chat is rate
 * limited and movement actions get a timeout so a stuck path can never hang the
 * loop. It is deliberately conservative and never griefs other players' builds.
 */

const JAVA_ACTIONS = [
  'follow', 'goto', 'stop', 'look', 'dig', 'place', 'attack', 'use',
  'inventory', 'chat', 'waypoint_add', 'waypoint_goto', 'skill_run',
];

// Bedrock has no movement/action implementation yet: only observe + talk.
const BEDROCK_ACTIONS = ['stop', 'look', 'inventory', 'chat', 'waypoint_add'];

const MOVE_ACTIONS = new Set(['goto', 'waypoint_goto']);
const HOLD_ACTIONS = new Set(['follow']);

const SYSTEM_PROMPT = `You are the brain of a Minecraft companion bot that plays alongside human players.
Reply with exactly one JSON object and nothing else:
{"thought": "<one short sentence>", "goal": "<optional: the current goal, only to change it>", "action": "<one action>", "args": { }, "say": "<optional short chat, or empty>"}
Rules:
- Think about what would actually help right now given the observation, then choose ONE action.
- Prefer social play: follow or look at players, answer chat, stay near the group.
- Only dig/place/attack when it clearly helps the shared goal; never grief other players' builds.
- If a previous action of the same kind just failed, try something different (see "Recent outcomes").
- waypoint_goto travels to a saved waypoint by name; waypoint_add remembers a useful spot (name + x/y/z).
- skill_run replays a learned routine by name.
- Keep "say" short (<120 chars) and only when useful, not every tick.
- "goal" is optional; set it only when the shared objective genuinely changed.
- If unsure, use {"action":"look","args":{"target":"nearest"},"say":""}.`;

const HISTORY_LIMIT = 12;
const FAILURE_LIMIT = 24;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function round(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? +n.toFixed(digits) : value;
}

function distance(a, b) {
  if (!a || !b) return null;
  return round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
}

export class Autopilot {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.coreUrl = options.coreUrl || controller.coreUrl || 'http://127.0.0.1:8080';
    this.running = false;
    this.goal = String(options.goal || '和玩家一起玩：跟随他们、按需帮忙、参与聊天');
    this.goalStack = [];
    this.intervalMs = Math.max(4000, Number(options.intervalMs) || 12000);
    this.modelId = options.modelId || '';
    this.minChatIntervalMs = Math.max(0, Number(options.minChatIntervalMs) || 6000);
    this.maxTicks = Number(options.maxTicks) || 0;
    this.moveTimeoutMs = Math.max(4000, Number(options.moveTimeoutMs) || 20000);
    this.ticks = 0;
    this.errors = 0;
    this.consecutiveErrors = 0;
    this.lastDecision = null;
    this.lastChatAt = 0;
    this.history = [];
    this.failures = [];
    this.log = [];
    this.abort = null;
  }

  status() {
    return {
      running: this.running,
      goal: this.goal,
      goalStack: this.goalStack.slice(-5),
      intervalMs: this.intervalMs,
      modelId: this.modelId || '(auto)',
      ticks: this.ticks,
      errors: this.errors,
      lastDecision: this.lastDecision,
      outcomes: this.history.slice(-6),
      recent: this.log.slice(-8),
    };
  }

  start(options = {}) {
    if (this.running) return this.status();
    if (options.goal) this.goal = String(options.goal);
    if (options.intervalMs) this.intervalMs = Math.max(4000, Number(options.intervalMs));
    if (options.modelId !== undefined) this.modelId = String(options.modelId || '');
    if (options.maxTicks !== undefined) this.maxTicks = Number(options.maxTicks) || 0;
    if (options.moveTimeoutMs !== undefined) this.moveTimeoutMs = Math.max(4000, Number(options.moveTimeoutMs) || this.moveTimeoutMs);
    this.running = true;
    this.ticks = 0;
    this.errors = 0;
    this.consecutiveErrors = 0;
    this.#note('autopilot started');
    this.abort = new AbortController();
    this.#loop().catch((error) => this.#note(`loop crashed: ${error.message}`));
    return this.status();
  }

  stop(reason = 'manual') {
    if (!this.running) return this.status();
    this.running = false;
    this.abort?.abort();
    this.#note(`autopilot stopped (${reason})`);
    return this.status();
  }

  #note(message) {
    this.log.push({ time: new Date().toISOString(), message });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    this.controller.emit('log', `autopilot: ${message}`);
  }

  async #loop() {
    while (this.running) {
      const started = Date.now();
      try {
        await this.tick();
        this.consecutiveErrors = 0;
      } catch (error) {
        this.errors += 1;
        this.consecutiveErrors += 1;
        this.#note(`tick failed: ${error.message}`);
      }
      this.ticks += 1;
      if (this.maxTicks && this.ticks >= this.maxTicks) {
        this.stop('max ticks reached');
        break;
      }
      const elapsed = Date.now() - started;
      // Back off harder after repeated failures instead of hammering the server.
      const wait = Math.max(1000, this.intervalMs - elapsed) + Math.min(this.consecutiveErrors, 5) * 1500;
      await sleep(wait);
    }
  }

  async tick() {
    if (!this.controller.connected) return;
    const bot = this.controller.bot;
    if (!bot || bot.state !== 'connected') return;

    await this.controller.captureWorld();
    const world = await this.controller.worldSnapshot();
    const observation = this.#observe(bot, world);
    const decision = await this.#decide(observation);
    if (!decision) {
      this.#note('model returned no usable decision');
      return;
    }
    this.lastDecision = { ...decision, time: new Date().toISOString() };
    await this.#apply(decision, observation);
  }

  /** Build a compact, human-readable observation for the model. */
  #observe(bot, world = { waypoints: [], skills: [] }) {
    const info = bot.describe();
    const recentChat = this.controller.chat.slice(-12).map((entry) => `${entry.username || 'system'}: ${entry.message}`);
    const mentioned = this.controller.chat.slice(-6).some((entry) =>
      (entry.message || '').includes(info.username) || /0kay|机器人|bot/i.test(entry.message || ''));
    const inventory = (info.inventory || [])
      .filter((item) => item && item.count)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map((item) => `${item.name}×${item.count}`);
    const players = (info.players || []).map((player) => ({
      name: player.name,
      distance: player.position ? distance(info.position, player.position) : null,
    }));
    return {
      edition: info.edition,
      username: info.username,
      goal: this.goal,
      goalStack: this.goalStack.slice(-5),
      state: info.state,
      health: info.health,
      food: info.food,
      dimension: info.dimension,
      position: info.position,
      held: info.held,
      inventory,
      players,
      mentioned,
      recentChat,
      waypoints: (world.waypoints || []).map((w) => ({ name: w.name, x: round(w.x), y: round(w.y), z: round(w.z) })),
      skills: (world.skills || []).map((s) => s.name),
      outcomes: this.history.slice(-6),
      failures: this.failures.slice(-6),
    };
  }

  #renderPrompt(o) {
    const lines = [
      `Edition: ${o.edition}`,
      `Bot: ${o.username}  State: ${o.state}`,
      `Goal: ${o.goal}`,
    ];
    if (o.goalStack.length) lines.push(`Goal stack: ${o.goalStack.join(' > ')}`);
    lines.push(
      `Health: ${o.health ?? 'unknown'}  Food: ${o.food ?? 'unknown'}  Dimension: ${o.dimension || 'unknown'}`,
      `Position: ${o.position ? `${round(o.position.x)}, ${round(o.position.y)}, ${round(o.position.z)}` : 'unknown'}`,
      `Held: ${o.held || 'nothing'}  Inventory: ${o.inventory.join(', ') || '(empty)'}`,
      `Players nearby: ${o.players.map((p) => (p.distance == null ? p.name : `${p.name}(${p.distance}m)`)).join(', ') || '(none)'}`,
      `Known waypoints: ${o.waypoints.map((w) => `${w.name}(${w.x},${w.y},${w.z})`).join(', ') || '(none)'}`,
      `Known skills: ${o.skills.join(', ') || '(none)'}`,
      `You were mentioned recently: ${o.mentioned ? 'yes' : 'no'}`,
    );
    if (o.outcomes.length) {
      lines.push('Recent outcomes (newest last):', ...o.outcomes.map((h) => `- ${h.action}: ${h.result}${h.detail ? ` (${h.detail})` : ''}`));
    }
    if (o.failures.length) {
      lines.push('Known failure patterns:', ...o.failures.map((f) => `- ${f}`));
    }
    lines.push('Recent chat (oldest first):', o.recentChat.join('\n') || '(none)');
    lines.push('', 'Choose the single next action now as JSON.');
    return lines.join('\n');
  }

  #allowedActions(edition) {
    return edition === 'bedrock' ? BEDROCK_ACTIONS : JAVA_ACTIONS;
  }

  async #decide(observation) {
    const prompt = this.#renderPrompt(observation);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
      response = await fetch(`${this.coreUrl}/api/mocr/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          prompt,
          system_prompt: SYSTEM_PROMPT,
          model_id: this.modelId || undefined,
          stream: false,
          max_tokens: 500,
          temperature: 0.5,
          session_id: 'minecraft-autopilot',
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`model gateway HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`model error: ${data.error}`);
    return this.#validate(extractJson(data.response || ''), observation.edition);
  }

  #validate(parsed, edition) {
    if (!parsed || typeof parsed !== 'object') return null;
    const action = String(parsed.action || '').trim();
    if (!this.#allowedActions(edition).includes(action)) return null;
    // Refuse a repeat of an action that just failed twice in a row.
    const recentSame = this.history.slice(-3).filter((h) => h.action === action && h.result === 'failed').length;
    if (recentSame >= 2) return null;
    const rawArgs = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
    const args = {};
    for (const [key, value] of Object.entries(rawArgs)) {
      if (value === null || value === undefined) continue;
      args[key] = typeof value === 'string' ? value.slice(0, 400) : value;
    }
    const say = typeof parsed.say === 'string' ? parsed.say.trim().slice(0, 200) : '';
    const thought = typeof parsed.thought === 'string' ? parsed.thought.trim().slice(0, 200) : '';
    const goal = typeof parsed.goal === 'string' ? parsed.goal.trim().slice(0, 200) : '';
    return { thought, goal, action, args, say };
  }

  #withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async #apply(decision, observation) {
    if (decision.goal && decision.goal !== this.goal) {
      this.goalStack.push(this.goal);
      if (this.goalStack.length > 5) this.goalStack.shift();
      this.goal = decision.goal;
      this.#note(`goal -> ${this.goal}`);
    }
    if (decision.say) {
      const now = Date.now();
      if (now - this.lastChatAt >= this.minChatIntervalMs && this.controller.connected) {
        try {
          await this.controller.action('chat', { message: decision.say });
          this.lastChatAt = now;
        } catch (error) {
          this.#note(`say failed: ${error.message}`);
        }
      }
    }

    const before = observation.position;
    const startedAt = Date.now();
    let result = null;
    let outcome = 'ok';
    let detail = '';
    try {
      if (MOVE_ACTIONS.has(decision.action)) {
        result = await this.#withTimeout(
          this.controller.action(decision.action, decision.args),
          this.moveTimeoutMs,
          decision.action,
        );
      } else if (HOLD_ACTIONS.has(decision.action)) {
        // follow keeps the goal active; don't await it forever.
        result = await this.controller.action(decision.action, decision.args);
      } else {
        result = await this.controller.action(decision.action, decision.args);
      }
    } catch (error) {
      outcome = 'failed';
      detail = error.message;
      this.#note(`${decision.action} -> ${error.message}`);
    }
    const elapsed = Date.now() - startedAt;
    if (outcome !== 'failed' && MOVE_ACTIONS.has(decision.action) && before) {
      const after = this.controller.bot?.describe?.().position;
      const moved = distance(before, after);
      detail = moved == null ? 'started' : `moved ${moved}m`;
      if (moved != null && moved < 1 && elapsed > 1500) {
        outcome = 'failed';
        detail = `did not move (${detail})`;
        this.#note(`${decision.action} -> ${detail}`);
      }
    }
    this.#record(decision.action, outcome, detail);
    return result;
  }

  #record(action, result, detail = '') {
    this.history.push({ time: new Date().toISOString(), action, result, detail });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    if (result === 'failed') {
      const message = detail ? `${action}: ${detail}` : action;
      if (!this.failures.includes(message)) this.failures.push(message);
      if (this.failures.length > FAILURE_LIMIT) this.failures.splice(0, this.failures.length - FAILURE_LIMIT);
    }
  }
}
