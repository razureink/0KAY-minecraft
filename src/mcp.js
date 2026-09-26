/**
 * Minimal Model Context Protocol (MCP) server over stdio.
 *
 * When MINECRAFT_MCP=1 the bot also speaks MCP on stdin/stdout, so an external
 * AI client (Claude Desktop, Cursor, any MCP client) can drive the companion —
 * the same idea as Numen's "外接大脑" (external brain) mode. It is dependency
 * free: newline-delimited JSON-RPC 2.0, implementing `initialize`, `tools/list`
 * and `tools/call`.
 *
 * NOTE: because stdio is the transport, callers must keep stdout clean for the
 * protocol; index.js routes console.log to stderr when MCP is enabled.
 */

import readline from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'minecraft_status',
    description: 'Full bot status: connection, health/food/position, players, inventory, autopilot, running task and pending consent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'minecraft_action',
    description: 'Run one Minecraft bot action. Actions: connect, disconnect, status, chat, players, follow, goto, stop, look, dig, place, attack, use, inventory, scan_blocks, scan_entities, scan_grid, plan_route, waypoint_add/goto/list/remove, skill_save/run/list/read/remove, task_status, task_stop, consent_reply. Long actions (goto/follow/dig/place/attack/use/skill_run) accept background:true to return a task_id.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string' },
        args: { type: 'object', description: 'Action arguments, e.g. {message} for chat, {x,y,z} for goto.' },
        background: { type: 'boolean', description: 'Run a long action as a background task and return a task_id.' },
      },
    },
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) { write({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

export function startMcpServer(controller, { version = '0.1.0' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      return; // ignore non-JSON noise
    }
    const { id, method, params } = request || {};
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: '0kay-minecraft', version },
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        let value;
        if (name === 'minecraft_status') {
          value = await controller.status();
        } else if (name === 'minecraft_action') {
          if (!args.action) throw new Error('action is required');
          value = await controller.dispatch(String(args.action), args.args || {}, { background: !!args.background });
        } else {
          throw new Error(`unknown tool: ${name}`);
        }
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
      } catch (error) {
        return ok(id, { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }], isError: true });
      }
    }
    if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  });

  return { stop: () => rl.close() };
}
