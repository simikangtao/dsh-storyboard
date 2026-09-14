// dsh-storyboard — end-of-chat Doubao-style visual storyboard for DSH Web.
//
// Server-only, zero runtime dependencies (node built-ins only).
//   1. Registers a compact system-prompt section instructing the model to
//      close substantive conversations with one `storyboard` tool call.
//   2. Registers the `storyboard` tool: renders a self-contained HTML card
//      (inline SVG diagram, numbered flow, facts grid, timeline, mechanism
//      list) and writes it under $DSH_HOME/storyboard/<session>/<time>.html.
//   3. Registers the `/storyboard [focus]` command: queues a follow-up turn
//      that asks the model to produce the storyboard right now.
//
// The model opens the returned file with the host `sidebar_open` tool — no
// client bundle is needed.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-storyboard';

/** Capabilities this plugin uses from the host context. */
export const inject = ['tools', 'systemPrompt', 'commands'];

const SECTION_NAME = 'plugin:dsh-storyboard';
const SECTION_ORDER = 82;
const TOOL_NAME = 'storyboard';
const COMMAND_NAME = 'storyboard';

/**
 * Injected into every system prompt while the plugin is enabled.
 * Kept deliberately small: it is paid on every request of a local model.
 */
const GUIDANCE = [
  'Storyboard: when a substantive exchange is ending (real work done, a plan produced, or a concept explained; skip trivial one-line replies), call the storyboard tool ONCE with a compact visual summary of what happened and how it works, then open the returned HTML file with the sidebar_open tool and mention it briefly in your reply.',
  'Storyboard fields: title (required, short), subtitle, flow (ordered steps of what was done), facts (key label/value pairs), howItWorks (mechanism points), diagram (nodes + edges of the core flow), timeline (time-ordered events). Keep every string short and omit sections you have no content for.',
].join('\n');

/* ------------------------------------------------------------------ */
/* Spec normalization                                                   */
/* ------------------------------------------------------------------ */

/** Truncate to n graphemes, appending an ellipsis when cut. */
function cut(value, n) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : s;
}

function asList(value, n) {
  return Array.isArray(value) ? value.slice(0, n) : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Clamp and sanitize the raw tool arguments into a renderable spec. */
function normalizeSpec(raw) {
  const input = asObject(raw);
  const diagram = asObject(input.diagram);
  const nodes = asList(diagram.nodes, 8)
    .map((node, i) => {
      const n = asObject(node);
      return { id: String(n.id ?? `n${i + 1}`), label: cut(n.label, 20) };
    })
    .filter((node) => node.label);
  const edges = asList(diagram.edges, 12)
    .map((edge) => {
      const e = asObject(edge);
      return { from: String(e.from ?? ''), to: String(e.to ?? ''), label: cut(e.label, 14) };
    })
    .filter((edge) => edge.from && edge.to);

  return {
    title: cut(input.title, 40),
    subtitle: cut(input.subtitle, 80),
    flow: asList(input.flow, 8)
      .map((step) => {
        const s = asObject(step);
        return { label: cut(s.label, 32), note: cut(s.note, 60) };
      })
      .filter((step) => step.label),
    facts: asList(input.facts, 8)
      .map((fact) => {
        const f = asObject(fact);
        return { label: cut(f.label, 16), value: cut(f.value, 60) };
      })
      .filter((fact) => fact.label || fact.value),
    howItWorks: asList(input.howItWorks, 8)
      .map((item) => cut(item, 90))
      .filter(Boolean),
    timeline: asList(input.timeline, 8)
      .map((item) => {
        const t = asObject(item);
        return { time: cut(t.time, 12), text: cut(t.text, 50) };
      })
      .filter((item) => item.text),
    diagram: nodes.length ? { nodes, edges } : null,
  };
}

/** HTML-escape every dynamic fragment. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* SVG diagram (layered DAG layout)                                     */
/* ------------------------------------------------------------------ */

const NODE_W = 132;
const NODE_H = 44;
const GAP_X = 64;
const GAP_Y = 36;

/**
 * Assign each node to a layer (longest incoming path, roots at 0) with a
 * capped relaxation loop, so cycles cannot hang the layout.
 */
function layoutDiagram(nodes, edges) {
  const known = new Set(nodes.map((node) => node.id));
  const valid = edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
  const layerOf = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass <= nodes.length; pass += 1) {
    let changed = false;
    for (const edge of valid) {
      const next = (layerOf.get(edge.from) ?? 0) + 1;
      if ((layerOf.get(edge.to) ?? 0) < next) {
        layerOf.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map();
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    if (!columns.has(layer)) columns.set(layer, []);
    columns.get(layer).push(node);
  }
  const layers = [...columns.keys()].sort((a, b) => a - b);
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length));
  const contentW = layers.length * NODE_W + (layers.length - 1) * GAP_X;
  const contentH = maxRows * NODE_H + (maxRows - 1) * GAP_Y;

  const pos = new Map();
  layers.forEach((layer, columnIndex) => {
    const column = columns.get(layer);
    const columnH = column.length * NODE_H + (column.length - 1) * GAP_Y;
    const startY = (contentH - columnH) / 2;
    column.forEach((node, rowIndex) => {
      pos.set(node.id, {
        cx: columnIndex * (NODE_W + GAP_X) + NODE_W / 2,
        cy: startY + rowIndex * (NODE_H + GAP_Y) + NODE_H / 2,
      });
    });
  });
  return { pos, valid, width: contentW, height: contentH };
}

/** Point on the border of box {cx, cy} along the line toward (px, py). */
function clipToBox(box, px, py) {
  const dx = px - box.cx;
  const dy = py - box.cy;
  if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };
  const tx = dx !== 0 ? (NODE_W / 2) / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? (NODE_H / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: box.cx + dx * t, y: box.cy + dy * t };
}

function edgePath(from, to) {
  const s = clipToBox(from, to.cx, to.cy);
  const e = clipToBox(to, from.cx, from.cy);
  if (Math.abs(e.x - s.x) > Math.abs(e.y - s.y)) {
    // Mostly horizontal: straight line with an arrowhead.
    return { d: `M ${s.x} ${s.y} L ${e.x} ${e.y}`, mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 - 8 }, curve: false };
  }
  // Same column (or mostly vertical): bow sideways so the arrow stays visible.
  const bow = 46 * (e.x >= s.x ? 1 : -1);
  const cx = (s.x + e.x) / 2 + bow;
  const cy = (s.y + e.y) / 2;
  return { d: `M ${s.x} ${s.y} Q ${cx} ${cy} ${e.x} ${e.y}`, mid: { x: cx, y: cy }, curve: true };
}

function renderDiagram(diagram) {
  const { pos, valid, width, height } = layoutDiagram(diagram.nodes, diagram.edges);
  const pad = 18;
  const widthPx = Math.max(width + pad * 2, 320);
  const heightPx = height + pad * 2 + 10;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" width="${widthPx}" height="${heightPx}" role="img" aria-label="flow diagram">`;
  svg += `<defs><marker id="sb-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto"><path d="M0,0 L8,4.5 L0,9 z" fill="#5b7a9f"/></marker></defs>`;

  for (const edge of valid) {
    const from = pos.get(edge.from);
    const to = pos.get(edge.to);
    if (!from || !to) continue;
    const path = edgePath(from, to);
    svg += `<path d="${path.d}" fill="none" stroke="#8aa4c0" stroke-width="1.6" marker-end="url(#sb-arrow)"/>`;
    if (edge.label) {
      svg += `<text x="${path.mid.x}" y="${path.mid.y}" text-anchor="middle" font-size="11.5" fill="#5a6b7d">${esc(edge.label)}</text>`;
    }
  }

  for (const node of diagram.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const x = p.cx - NODE_W / 2;
    const y = p.cy - NODE_H / 2;
    svg += `<g><rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="#eef4fa" stroke="#5b7a9f" stroke-width="1.3"/>`;
    svg += `<text x="${p.cx}" y="${p.cy + 4.5}" text-anchor="middle" font-size="12.5" fill="#17324d">${esc(node.label)}</text></g>`;
  }
  svg += '</svg>';
  return svg;
}

/* ------------------------------------------------------------------ */
/* HTML document                                                        */
/* ------------------------------------------------------------------ */

const CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;padding:20px;background:#f2f5f8;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;color:#1c2b3a}',
  '.card{max-width:760px;margin:0 auto;background:#fff;border:1px solid #dde6ee;border-radius:14px;padding:26px 30px;box-shadow:0 2px 10px rgba(28,43,58,.06)}',
  'h1{margin:0;font-size:24px;line-height:1.3}',
  '.sub{margin:6px 0 0;font-size:14px;color:#5a6b7d}',
  'section{margin-top:24px}',
  'h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#5b7a9f}',
  '.diagram{overflow-x:auto;padding:6px 2px}',
  '.diagram svg{min-width:340px}',
  'ol.flow{list-style:none;margin:0;padding:0;counter-reset:flow}',
  'ol.flow li{counter-increment:flow;position:relative;padding:0 0 14px 42px}',
  'ol.flow li::before{content:counter(flow);position:absolute;left:0;top:-2px;width:28px;height:28px;border-radius:50%;background:#eef4fa;border:1.5px solid #5b7a9f;color:#2c4d70;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center}',
  'ol.flow li:not(:last-child)::after{content:"";position:absolute;left:13px;top:26px;bottom:2px;width:2px;background:#cfdcea}',
  '.fl-label{display:block;font-size:15px;font-weight:600}',
  '.fl-note{display:block;font-size:13px;color:#5a6b7d;margin-top:2px}',
  '.facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
  '.fact{border:1px solid #dde6ee;border-radius:10px;padding:10px 12px}',
  '.f-label{font-size:12px;color:#5a6b7d;margin-bottom:4px}',
  '.f-value{font-size:14.5px;font-weight:600;word-break:break-word}',
  'ul.timeline{list-style:none;margin:0;padding:0 0 4px 24px;border-left:2px dotted #b9c9d9}',
  'ul.timeline li{position:relative;padding:0 0 12px;font-size:14px}',
  'ul.timeline li::before{content:"";position:absolute;left:-31px;top:3px;width:10px;height:10px;border-radius:50%;background:#5b7a9f;border:2px solid #fff}',
  '.t-time{display:inline-block;min-width:64px;font-weight:600;color:#2c4d70}',
  'ol.hiw{margin:0;padding-left:20px;font-size:14.5px;line-height:1.65}',
  'ol.hiw li{margin-bottom:6px}',
  'footer{margin-top:26px;padding-top:12px;border-top:1px solid #eef2f6;font-size:12px;color:#8a99a9}',
  '@media (max-width:560px){.facts{grid-template-columns:1fr}}',
].join('\n');

function renderHtml(spec, dateText) {
  const parts = [];

  parts.push(
    `<section class="head"><h1>${esc(spec.title)}</h1>${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ''}</section>`,
  );

  if (spec.diagram) {
    parts.push(`<section><h2>How it connects</h2><div class="diagram">${renderDiagram(spec.diagram)}</div></section>`);
  }
  if (spec.flow.length) {
    const items = spec.flow
      .map(
        (step) =>
          `<li><span class="fl-label">${esc(step.label)}</span>${step.note ? `<span class="fl-note">${esc(step.note)}</span>` : ''}</li>`,
      )
      .join('');
    parts.push(`<section><h2>What was done</h2><ol class="flow">${items}</ol></section>`);
  }
  if (spec.facts.length) {
    const items = spec.facts
      .map((fact) => `<div class="fact"><div class="f-label">${esc(fact.label)}</div><div class="f-value">${esc(fact.value)}</div></div>`)
      .join('');
    parts.push(`<section><h2>Key facts</h2><div class="facts">${items}</div></section>`);
  }
  if (spec.timeline.length) {
    const items = spec.timeline
      .map((item) => `<li><span class="t-time">${item.time ? esc(item.time) : '&nbsp;'}</span><span class="t-text">${esc(item.text)}</span></li>`)
      .join('');
    parts.push(`<section><h2>Timeline</h2><ul class="timeline">${items}</ul></section>`);
  }
  if (spec.howItWorks.length) {
    const items = spec.howItWorks.map((item) => `<li>${esc(item)}</li>`).join('');
    parts.push(`<section><h2>How it works</h2><ol class="hiw">${items}</ol></section>`);
  }

  parts.push(`<footer>Generated by dsh-storyboard &middot; ${esc(dateText)}</footer>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="card">
${parts.join('\n')}
</main>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* Tool                                                                 */
/* ------------------------------------------------------------------ */

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short card title, max 40 characters.' },
    subtitle: { type: 'string', description: 'One line of context, max 80 characters.' },
    flow: {
      type: 'array',
      maxItems: 8,
      description: 'Ordered steps of what was done.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Step name, max 32 characters.' },
          note: { type: 'string', description: 'Optional detail, max 60 characters.' },
        },
        required: ['label'],
      },
    },
    facts: {
      type: 'array',
      maxItems: 8,
      description: 'Key label/value pairs worth remembering.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'Max 16 characters.' },
          value: { type: 'string', description: 'Max 60 characters.' },
        },
        required: ['label', 'value'],
      },
    },
    howItWorks: {
      type: 'array',
      maxItems: 8,
      description: 'Mechanism points: how the result actually works, max 90 characters each.',
      items: { type: 'string' },
    },
    diagram: {
      type: 'object',
      additionalProperties: false,
      description: 'Core flow as a small directed graph, rendered as inline SVG.',
      properties: {
        nodes: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Unique node id, e.g. n1.' },
              label: { type: 'string', description: 'Node caption, max 20 characters.' },
            },
            required: ['id', 'label'],
          },
        },
        edges: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string', description: 'Optional edge caption, max 14 characters.' },
            },
            required: ['from', 'to'],
          },
        },
      },
      required: ['nodes'],
    },
    timeline: {
      type: 'array',
      maxItems: 8,
      description: 'Time-ordered events, when the conversation has a sequence.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'string', description: 'Optional short time/stage, max 12 characters.' },
          text: { type: 'string', description: 'Event text, max 50 characters.' },
        },
        required: ['text'],
      },
    },
  },
  required: ['title'],
};

/** Resolve the session-scoped storyboard directory under DSH home. */
async function storyboardDir(session) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const raw = String(session?.id ?? session?.header?.id ?? 'default');
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const dir = join(home, 'storyboard', safe);
  await mkdir(dir, { recursive: true });
  return dir;
}

const toolExecute = async (args, exec) => {
  try {
    const spec = normalizeSpec(args);
    if (!spec.title) {
      return { text: 'Storyboard rejected: "title" is required (a short name for what just happened).' };
    }
    const dir = await storyboardDir(exec?.agent?.session);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const file = join(dir, `${stamp}.html`);
    const dateText = new Date().toLocaleString();
    await writeFile(file, renderHtml(spec, dateText), 'utf8');
    return { text: `Storyboard saved to ${file}. Open it in the sidebar with the sidebar_open tool (pass this exact path) and mention it briefly in your reply.` };
  } catch (error) {
    return { text: `Storyboard failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/* ------------------------------------------------------------------ */
/* Plugin entry point                                                   */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const disposeSection = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: GUIDANCE,
  });

  const disposeTool = ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Generate a compact Doubao-style visual storyboard (one self-contained HTML file with an inline SVG diagram) summarizing what was done and how it works. Call it once at the end of a substantive exchange, then open the returned file with sidebar_open.',
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: toolExecute,
  });

  const disposeCommand = ctx.commands.register({
    name: COMMAND_NAME,
    description: 'Generate a visual storyboard of this conversation right now',
    input: { hint: '[optional focus for the storyboard]' },
    handler(invocation) {
      const focus = String(invocation.rawInput ?? '').trim();
      const text = `[storyboard requested] The user invoked /${COMMAND_NAME}. Call the storyboard tool exactly once with a compact summary of this conversation${
        focus ? ` — focus on: ${focus}` : ''
      } (title is required), then open the returned HTML file with the sidebar_open tool and mention it briefly.`;
      try {
        // Hand-written UserMessage: { id, role, content, source } + frozen,
        // matching the host's createUserMessage() shape without depending
        // on the dsh-llm package.
        invocation.agent.followup(
          Object.freeze({
            id: `storyboard-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }),
        );
        return { kind: 'success', text: 'Storyboard generation queued — it will appear in a moment.' };
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  return () => {
    disposeCommand();
    disposeTool();
    disposeSection();
  };
}
