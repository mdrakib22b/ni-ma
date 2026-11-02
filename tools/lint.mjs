#!/usr/bin/env node
// Dependency-light static checks for the Ni'ma PWA single-file architecture.
//
// The whole app lives in project/pwa/index.html: a <x-dc> markup block plus a
// <script data-dc-script> that defines `class Component extends DCLogic`. The
// dc-runtime compiles that script with `new Function`, so ordinary JS mistakes
// (duplicate class members, duplicate object keys) fail *silently at runtime*
// instead of at parse time — exactly the class of bug that made the Budget
// "Create section" button do nothing (two `saveSection` methods, the second
// shadowing the first).
//
// This script parses that embedded logic with a real JS parser and fails CI on:
//   1. duplicate class members  (no-dupe-class-members)
//   2. duplicate object keys    (no-dupe-keys)
//   3. template bindings `{{ name }}` in the markup that renderVals() never returns
//
// It has no effect on the shipped app — it only reads the source files.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as acorn from 'acorn';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(root, 'project', 'pwa', 'index.html');

const errors = [];
const err = (msg) => errors.push(msg);

const html = readFileSync(INDEX, 'utf8');

// ---- extract the two regions we care about ---------------------------------
function extractScript(src) {
  const open = src.match(/<script[^>]*\bdata-dc-script\b[^>]*>/i);
  if (!open) throw new Error('could not find <script data-dc-script> in index.html');
  const start = open.index + open[0].length;
  const end = src.indexOf('</script>', start);
  if (end === -1) throw new Error('unterminated <script data-dc-script>');
  return { code: src.slice(start, end), offset: start };
}
function extractMarkup(src) {
  const start = src.indexOf('<x-dc>');
  const end = src.indexOf('</x-dc>');
  if (start === -1 || end === -1) throw new Error('could not find <x-dc> markup block');
  return src.slice(start + '<x-dc>'.length, end);
}

const { code } = extractScript(html);
const markup = extractMarkup(html);

// ---- parse the logic --------------------------------------------------------
let ast;
try {
  ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
} catch (e) {
  err(`index.html <script data-dc-script> failed to parse: ${e.message}`);
  report();
}

// Minimal recursive walker (avoids a second dependency).
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const k in node) {
    if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node));
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

const keyName = (n) => (n.type === 'Identifier' ? n.name : n.type === 'Literal' ? String(n.value) : null);

// ---- check 1: duplicate class members --------------------------------------
walk(ast, (node) => {
  if (node.type !== 'ClassBody') return;
  const seen = new Map();
  for (const m of node.body) {
    if (m.type !== 'MethodDefinition' && m.type !== 'PropertyDefinition') continue;
    if (m.computed) continue;
    const name = keyName(m.key);
    if (name == null) continue;
    // getters/setters legitimately pair up; key them by kind.
    const sig = `${m.static ? 'static ' : ''}${m.kind || 'field'} ${name}`;
    if (m.kind === 'get' || m.kind === 'set') continue;
    if (seen.has(sig)) {
      err(`duplicate class member "${name}" (lines ${seen.get(sig)} and ${m.key.loc.start.line} of the data-dc-script block) — the second definition silently shadows the first`);
    } else {
      seen.set(sig, m.key.loc.start.line);
    }
  }
});

// ---- check 2: duplicate object keys ----------------------------------------
walk(ast, (node) => {
  if (node.type !== 'ObjectExpression') return;
  const seen = new Map();
  for (const p of node.properties) {
    if (p.type !== 'Property' || p.computed) continue;
    const name = keyName(p.key);
    if (name == null) continue;
    if (p.kind === 'get' || p.kind === 'set') continue;
    if (seen.has(name)) {
      err(`duplicate object key "${name}" (lines ${seen.get(name)} and ${p.key.loc.start.line} of the data-dc-script block) — the later value overrides the earlier`);
    } else {
      seen.set(name, p.key.loc.start.line);
    }
  }
});

// ---- check 3: template bindings resolve to a renderVals() key ---------------
// Collect the keys renderVals() returns (its returned object literals).
const provided = new Set();
walk(ast, (node) => {
  if (node.type !== 'MethodDefinition' || keyName(node.key) !== 'renderVals') return;
  walk(node, (n, parent) => {
    if (n.type === 'ObjectExpression' && parent && parent.type === 'ReturnStatement') {
      for (const p of n.properties) {
        if (p.type === 'Property') { const k = keyName(p.key); if (k) provided.add(k); }
        if (p.type === 'SpreadElement') provided.add('*'); // lenient: spread may add anything
      }
    }
  });
});

// Names also come from <sc-for as="x"> aliases and a few literals.
const aliases = new Set(['true', 'false', 'null', 'undefined']);
for (const m of markup.matchAll(/\bas=["']([A-Za-z_$][\w$]*)["']/g)) aliases.add(m[1]);

const spreadLenient = provided.has('*');
const missing = new Set();
if (!spreadLenient) {
  for (const m of markup.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const expr = m[1].trim();
    // Only check bare identifiers or simple dotted access — skip anything with
    // operators, calls, quotes, etc. to avoid false positives.
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(expr)) continue;
    const rootId = expr.split('.')[0];
    if (provided.has(rootId) || aliases.has(rootId)) continue;
    missing.add(expr);
  }
}
for (const b of missing) err(`template binding "{{ ${b} }}" is not returned by renderVals() and is not an sc-for alias — it will render blank`);

report();

function report() {
  if (errors.length === 0) {
    console.log('lint: OK — no duplicate class members, duplicate object keys, or dangling template bindings');
    process.exit(0);
  }
  console.error(`lint: ${errors.length} problem(s) found:\n`);
  for (const e of errors) console.error('  ✗ ' + e);
  console.error('');
  process.exit(1);
}
