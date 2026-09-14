// Standalone smoke test for dsh-storyboard (no DSH host needed).
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-storyboard-test-'));

const mod = await import(new URL('../lib/index.mjs', import.meta.url));
console.log('exports:', Object.keys(mod).join(', '));
console.log('inject:', JSON.stringify(mod.inject));

// --- apply() with a fake ctx -------------------------------------------
const registered = { sections: [], tools: [], commands: [] };
const ctx = {
  systemPrompt: { section: (s) => (registered.sections.push(s), () => registered.sections.pop()) },
  tools: { register: (t) => (registered.tools.push(t), () => registered.tools.pop()) },
  commands: { register: (c) => (registered.commands.push(c), () => registered.commands.pop()) },
};
const cleanup = mod.apply(ctx);
console.log('applied ->', registered.sections.length, 'section(s);', registered.tools.length, 'tool(s);', registered.commands.length, 'command(s)');
if (registered.sections.length !== 1 || registered.tools.length !== 1 || registered.commands.length !== 1) {
  console.error('FAIL: expected one of each');
  process.exit(1);
}
if (registered.commands[0].name !== 'storyboard' || registered.commands[0].description.length === 0) {
  console.error('FAIL: bad command definition');
  process.exit(1);
}
if (registered.tools[0].name !== 'storyboard' || registered.tools[0].parameters.required[0] !== 'title') {
  console.error('FAIL: bad tool definition');
  process.exit(1);
}

// --- tool execute: full spec -------------------------------------------
const sample = {
  title: 'Built the dsh-storyboard plugin',
  subtitle: 'End-of-chat Doubao-style visual summaries for DSH Web, light and offline',
  flow: [
    { label: 'Studied the plugin APIs', note: 'commands, tools, systemPrompt, followup verified against installed plugins' },
    { label: 'Wrote package.json + cordis.patch.yml', note: 'bundle patch declares the profile row' },
    { label: 'Wrote lib/index.mjs', note: 'zero-dep renderer: SVG DAG, flow, facts, timeline' },
    { label: 'Smoke tested the renderer', note: 'this run' },
  ],
  facts: [
    { label: 'Dependencies', value: 'none (node built-ins only)' },
    { label: 'Output', value: 'single HTML file, ~10-20KB, no network' },
    { label: 'Storage', value: '$DSH_HOME/storyboard/<session>/' },
    { label: 'Command', value: '/storyboard [focus]' },
  ],
  diagram: {
    nodes: [
      { id: 'n1', label: 'Chat ends' },
      { id: 'n2', label: 'storyboard tool' },
      { id: 'n3', label: 'HTML + SVG file' },
      { id: 'n4', label: 'sidebar_open' },
      { id: 'n5', label: 'User sees card' },
    ],
    edges: [
      { from: 'n1', to: 'n2', label: 'model calls' },
      { from: 'n2', to: 'n3', label: 'renders + writes' },
      { from: 'n3', to: 'n4', label: 'path returned' },
      { from: 'n4', to: 'n5' },
    ],
  },
  timeline: [
    { time: 'v0.1', text: 'Server-only plugin: tool + command + prompt section' },
    { time: 'later', text: 'Optional settings toggle and richer diagrams' },
  ],
  howItWorks: [
    'A prompt section instructs the model to close substantive exchanges with one storyboard tool call.',
    'The tool normalizes the spec (capped lengths, escaped) and renders one self-contained HTML document with an inline SVG DAG (layered by longest incoming path).',
    'The file lands under $DSH_HOME/storyboard/<session>/; the model opens it with the host sidebar_open tool, so no client bundle is needed.',
  ],
};
const res1 = await registered.tools[0].execute(sample, { agent: { session: { id: 'sess-test-123' } } });
console.log('tool ->', res1.text);
const saved = await readFile(res1.text.match(/(C:[^\s]+\.html|\.html)/)?.[0] ?? res1.text, 'utf8').catch(async () => {
  const dir = join(process.env.DSH_HOME, 'storyboard', 'sess-test-123');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).sort();
  return readFile(join(dir, files[files.length - 1]), 'utf8');
});
console.log('html bytes:', saved.length, '| doctype:', saved.startsWith('<!doctype html>'), '| svg:', saved.includes('<svg'), '| escape check:', !saved.includes('undefined'));
if (!saved.includes('Built the dsh-storyboard plugin')) { console.error('FAIL: title missing'); process.exit(1); }
if (!saved.includes('marker-end="url(#sb-arrow)"')) { console.error('FAIL: arrow marker missing'); process.exit(1); }

// --- tool execute: hostile input (escaping + caps) --------------------
const res2 = await registered.tools[0].execute({ title: '<img src=x onerror=alert(1)>' + 'A'.repeat(80) }, {});
const dir2 = join(process.env.DSH_HOME, 'storyboard', 'default');
const { readdir } = await import('node:fs/promises');
const files2 = (await readdir(dir2)).sort();
const saved2 = await readFile(join(dir2, files2[files2.length - 1]), 'utf8');
if (saved2.includes('<img src=x')) { console.error('FAIL: XSS not escaped'); process.exit(1); }
if (saved2.includes('…') === false) { console.error('FAIL: truncation ellipsis missing'); process.exit(1); }
console.log('escape test OK:', res2.text.split(' ')[2]);

// --- tool execute: missing title ---------------------------------------
const res3 = await registered.tools[0].execute({ flow: [] }, {});
if (!res3.text.startsWith('Storyboard rejected')) { console.error('FAIL: missing title not rejected'); process.exit(1); }
console.log('missing-title OK');

// --- command handler ----------------------------------------------------
let followed = null;
const invocation = {
  rawInput: ' the install steps ',
  agent: { followup: (msg) => { followed = msg; } },
};
const cmdRes = registered.commands[0].handler(invocation);
console.log('command ->', JSON.stringify(cmdRes), '| followup id:', followed?.id?.slice(0, 20), '| role:', followed?.role, '| text head:', followed?.content?.[0]?.text.slice(0, 60));
if (cmdRes.kind !== 'success' || followed?.role !== 'user' || !followed?.content?.[0]?.text.includes('the install steps')) {
  console.error('FAIL: command handler');
  process.exit(1);
}

// --- cleanup ------------------------------------------------------------
cleanup();
if (registered.sections.length !== 0 || registered.tools.length !== 0 || registered.commands.length !== 0) {
  console.error('FAIL: cleanup did not dispose all registrations');
  process.exit(1);
}
console.log('cleanup OK — all registrations disposed');
console.log('\nALL TESTS PASSED');
console.log('DSH_HOME for inspection:', process.env.DSH_HOME);
