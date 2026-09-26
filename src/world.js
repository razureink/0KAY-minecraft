/**
 * Persistent world knowledge per server: named waypoints (landmarks, chests,
 * player bases) and reusable action skills. Stored under data/world.json so the
 * bot "learns" a server over time and can recall/goto/replay later.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

function slug(value, fallback) {
  const text = String(value || '').trim().toLowerCase().replace(/[^\w\-\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  return text || fallback;
}

export class WorldStore {
  constructor(file) {
    this.file = file;
    this.skillsDir = process.env.MINECRAFT_SKILLS_DIR || path.join(process.cwd(), 'skills');
    this.data = { servers: {} };
    this.markdown = [];
    this.ready = this.#load();
    this.readySkills = this.#loadMarkdown();
  }

  async #load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.servers) this.data = parsed;
    } catch {
      this.data = { servers: {} };
    }
  }

  /**
   * Markdown skills are shared knowledge (how to play a mod, base rules),
   * mirroring Numen's `config/numen/skills/*.md`: drop a .md file in the skills
   * dir and the bot can read it. Zero code, no per-mod adaptation.
   */
  async #loadMarkdown() {
    this.markdown = [];
    let entries = [];
    try {
      entries = await fs.readdir(this.skillsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      try {
        const content = await fs.readFile(path.join(this.skillsDir, name), 'utf8');
        const lines = content.split(/\r?\n/);
        const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line));
        const title = heading ? heading.replace(/^#{1,3}\s+/, '').trim() : name.replace(/\.md$/i, '');
        const note = lines.map((line) => line.trim()).find((line) => line && !line.startsWith('#')) || '';
        this.markdown.push({
          id: slug(name.replace(/\.md$/i, ''), name),
          name: title,
          note: note.slice(0, 140),
          body: content.slice(0, 4000),
          source: 'markdown',
        });
      } catch {
        // a broken file should never stop the others
      }
    }
  }

  async markdownSkills() {
    await this.readySkills;
    return this.markdown;
  }

  async markdownSkill(idOrName) {
    const target = String(idOrName || '').trim().toLowerCase();
    return (await this.markdownSkills()).find((skill) => skill.id === slug(idOrName, '') || skill.name.toLowerCase() === target) || null;
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // persistence is best-effort; in-memory knowledge still works for the session
    }
  }

  async server(key) {
    await this.ready;
    const id = String(key || 'default');
    if (!this.data.servers[id]) this.data.servers[id] = { waypoints: {}, skills: {}, updated_at: '' };
    const entry = this.data.servers[id];
    entry.waypoints ||= {};
    entry.skills ||= {};
    return entry;
  }

  async listWaypoints(key) {
    return Object.values((await this.server(key)).waypoints);
  }

  async addWaypoint(key, wp = {}) {
    const entry = await this.server(key);
    const id = slug(wp.id || wp.name, `wp-${Date.now()}`);
    const record = {
      id,
      name: String(wp.name || id),
      x: Number(wp.x), y: Number(wp.y), z: Number(wp.z),
      dimension: wp.dimension || '',
      type: wp.type || 'landmark',
      note: String(wp.note || ''),
      created_at: entry.waypoints[id]?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if ([record.x, record.y, record.z].some((n) => !Number.isFinite(n))) throw new Error('x, y, z are required');
    entry.waypoints[id] = record;
    entry.updated_at = record.updated_at;
    await this.save();
    return record;
  }

  async removeWaypoint(key, id) {
    const entry = await this.server(key);
    const removed = !!entry.waypoints[slug(id, '')];
    delete entry.waypoints[slug(id, '')];
    if (removed) await this.save();
    return removed;
  }

  async findWaypoint(key, idOrName) {
    const entry = await this.server(key);
    const target = String(idOrName || '').trim().toLowerCase();
    if (!target) return null;
    for (const wp of Object.values(entry.waypoints)) {
      if (wp.id === slug(idOrName, '') || String(wp.name).toLowerCase() === target) return wp;
    }
    return null;
  }

  async listSkills(key) {
    return Object.values((await this.server(key)).skills);
  }

  async saveSkill(key, skill = {}) {
    const entry = await this.server(key);
    const steps = Array.isArray(skill.steps) ? skill.steps.filter((s) => s && typeof s.action === 'string') : [];
    if (!steps.length) throw new Error('steps are required');
    const id = slug(skill.id || skill.name, `skill-${Date.now()}`);
    const record = {
      id,
      name: String(skill.name || id),
      note: String(skill.note || ''),
      steps,
      runs: entry.skills[id]?.runs || 0,
      updated_at: new Date().toISOString(),
    };
    entry.skills[id] = record;
    entry.updated_at = record.updated_at;
    await this.save();
    return record;
  }

  async getSkill(key, id) {
    const entry = await this.server(key);
    return entry.skills[slug(id, '')] || null;
  }

  async removeSkill(key, id) {
    const entry = await this.server(key);
    const removed = !!entry.skills[slug(id, '')];
    delete entry.skills[slug(id, '')];
    if (removed) await this.save();
    return removed;
  }

  async markSkillRun(key, id) {
    const entry = await this.server(key);
    const skill = entry.skills[slug(id, '')];
    if (skill) {
      skill.runs = (skill.runs || 0) + 1;
      skill.last_run_at = new Date().toISOString();
      await this.save();
    }
    return skill;
  }
}
