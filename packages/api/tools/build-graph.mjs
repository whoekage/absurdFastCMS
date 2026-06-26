// Build an interactive dependency graph of packages/api/src using the TypeScript AST.
// Nodes = source files (colored by subsystem), edges = intra-src imports. Each node carries its exported
// functions/classes/types with parameter signatures. Emits a self-contained HTML (vis-network via CDN).
//
// Run:  node packages/api/tools/build-graph.mjs   (from repo root or packages/api)
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const OUT = path.resolve(HERE, '..', 'api-dependency-graph.html');

/** Walk a dir for .ts files (skip .d.ts / .test.ts — src has none, but be safe). */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.ts$/.test(e.name) && !/\.(d|test)\.ts$/.test(e.name) ? [p] : [];
  });
}

const files = walk(SRC);
const idOf = (abs) => path.relative(SRC, abs).replace(/\\/g, '/'); // e.g. "db/registry.ts"
const subsystemOf = (id) => {
  const parts = id.split('/');
  return parts.length === 1 ? '(root)' : parts.slice(0, parts.length - 1).join('/');
};

const nodes = new Map(); // id -> { id, label, sub, exports: [...] }
const edges = []; // { from, to }
const known = new Set(files.map(idOf));

/** Compact a parameter list to `name: Type` strings (types trimmed to one line). */
function paramSig(params, sf) {
  return params.map((p) => {
    const name = p.name.getText(sf);
    const opt = p.questionToken || p.initializer ? '?' : '';
    const type = p.type ? p.type.getText(sf).replace(/\s+/g, ' ') : '';
    return type ? `${name}${opt}: ${type}` : `${name}${opt}`;
  });
}
const ret = (node, sf) => (node.type ? node.type.getText(sf).replace(/\s+/g, ' ') : '');

for (const abs of files) {
  const id = idOf(abs);
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
  const node = { id, label: path.basename(id), sub: subsystemOf(id), exports: [] };
  nodes.set(id, node);

  const resolveSpec = (spec) => {
    if (!spec.startsWith('.')) return null; // external pkg — not an intra-src edge
    let target = path.relative(SRC, path.resolve(path.dirname(abs), spec)).replace(/\\/g, '/');
    if (!/\.ts$/.test(target)) target += '.ts';
    return known.has(target) ? target : null;
  };
  const isExported = (n) =>
    (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;

  sf.forEachChild((n) => {
    // --- imports / re-export edges ---
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const to = resolveSpec(n.moduleSpecifier.text);
      if (to && to !== id) edges.push({ from: id, to });
    }
    // --- exported declarations ---
    if (ts.isFunctionDeclaration(n) && n.name && isExported(n)) {
      node.exports.push({ kind: 'fn', name: n.name.text, params: paramSig(n.parameters, sf), ret: ret(n, sf) });
    } else if (ts.isClassDeclaration(n) && n.name && isExported(n)) {
      const methods = n.members
        .filter((m) => ts.isMethodDeclaration(m) && m.name && !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private))
        .map((m) => ({ name: m.name.getText(sf), params: paramSig(m.parameters, sf), ret: ret(m, sf) }));
      node.exports.push({ kind: 'class', name: n.name.text, methods });
    } else if (ts.isInterfaceDeclaration(n) && isExported(n)) {
      node.exports.push({ kind: 'type', name: n.name.text });
    } else if (ts.isTypeAliasDeclaration(n) && isExported(n)) {
      node.exports.push({ kind: 'type', name: n.name.text });
    } else if (ts.isEnumDeclaration(n) && isExported(n)) {
      node.exports.push({ kind: 'enum', name: n.name.text });
    } else if (ts.isVariableStatement(n) && isExported(n)) {
      for (const d of n.declarationList.declarations) {
        const name = d.name.getText(sf);
        if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          node.exports.push({ kind: 'fn', name, params: paramSig(d.initializer.parameters, sf), ret: ret(d.initializer, sf) });
        } else {
          node.exports.push({ kind: 'const', name });
        }
      }
    }
  });
}

// Dedupe edges + compute degrees for node sizing.
const edgeSet = new Set();
const dedupEdges = [];
const indeg = new Map(), outdeg = new Map();
for (const e of edges) {
  const k = e.from + '->' + e.to;
  if (edgeSet.has(k)) continue;
  edgeSet.add(k);
  dedupEdges.push(e);
  outdeg.set(e.from, (outdeg.get(e.from) || 0) + 1);
  indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
}

const subs = [...new Set([...nodes.values()].map((n) => n.sub))].sort();
const data = {
  nodes: [...nodes.values()].map((n) => ({ ...n, in: indeg.get(n.id) || 0, out: outdeg.get(n.id) || 0 })),
  edges: dedupEdges,
  subs,
  stats: { files: nodes.size, edges: dedupEdges.length, subs: subs.length },
};

const html = `<!doctype html><html><head><meta charset="utf-8"><title>@conti/api — dependency graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  :root{--bg:#0f1115;--panel:#1a1d24;--line:#2a2e38;--fg:#e6e6e6;--mut:#8a90a0}
  *{box-sizing:border-box} html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  #wrap{display:flex;height:100vh}
  #net{flex:1;height:100%}
  #side{width:430px;border-left:1px solid var(--line);background:var(--panel);overflow:auto;padding:14px 16px}
  #side h2{margin:.2em 0;font-size:15px}
  #side .path{color:var(--mut);font-size:11px;word-break:break-all;margin-bottom:10px}
  .exp{margin:8px 0;padding:8px 10px;background:#12151b;border:1px solid var(--line);border-radius:6px}
  .exp .k{display:inline-block;min-width:46px;color:#7aa2f7;font-weight:600}
  .exp .n{color:#9ece6a;font-weight:600}
  .exp .sig{color:var(--mut);white-space:pre-wrap}
  .meth{margin:3px 0 3px 14px;color:var(--mut)}
  .meth .mn{color:#e0af68}
  #hdr{padding:12px 16px;border-bottom:1px solid var(--line)}
  #hdr h1{margin:0;font-size:14px}
  #hdr .s{color:var(--mut);font-size:11px}
  #search{width:100%;margin-top:8px;padding:6px 8px;background:#12151b;border:1px solid var(--line);color:var(--fg);border-radius:6px}
  #legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .lg{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--mut);cursor:pointer;user-select:none}
  .lg .sw{width:11px;height:11px;border-radius:3px}
  .hint{color:var(--mut);font-size:11px;margin-top:10px}
</style></head><body>
<div id="wrap">
  <div style="flex:1;display:flex;flex-direction:column;min-width:0">
    <div id="hdr">
      <h1>@conti/api — dependency graph</h1>
      <div class="s" id="stats"></div>
      <input id="search" placeholder="поиск файла/функции… (Enter — фокус на узле)">
      <div id="legend"></div>
    </div>
    <div id="net"></div>
  </div>
  <div id="side"><div class="hint">Клик по узлу — экспортируемые функции/классы/типы и их параметры.<br>Колесо — зум, перетаскивание — пан. Клик по цвету в легенде — спрятать/показать подсистему.</div></div>
</div>
<script>
const DATA = ${JSON.stringify(data)};
const PALETTE = ['#7aa2f7','#9ece6a','#e0af68','#f7768e','#bb9af7','#7dcfff','#ff9e64','#73daca','#c0caf5','#cfc9c2'];
const color = {}; DATA.subs.forEach((s,i)=>color[s]=PALETTE[i%PALETTE.length]);
document.getElementById('stats').textContent = DATA.stats.files+' files · '+DATA.stats.edges+' imports · '+DATA.stats.subs+' subsystems';

const nodes = new vis.DataSet(DATA.nodes.map(n=>({
  id:n.id, label:n.label, group:n.sub,
  value: 4 + n.in*2 + n.out,            // size ~ fan-in/out
  color:{background:color[n.sub],border:'#0008',highlight:{background:color[n.sub],border:'#fff'}},
  font:{color:'#dfe6f0',size:12,face:'ui-monospace'},
})));
const edges = new vis.DataSet(DATA.edges.map(e=>({from:e.from,to:e.to,arrows:'to',color:{color:'#39405055',highlight:'#7aa2f7'},width:0.6,smooth:{type:'continuous'}})));
const net = new vis.Network(document.getElementById('net'), {nodes,edges}, {
  physics:{solver:'forceAtlas2Based',forceAtlas2Based:{gravitationalConstant:-45,springLength:90,springConstant:0.06},stabilization:{iterations:220}},
  interaction:{hover:true,tooltipDelay:120},
  nodes:{shape:'dot',scaling:{min:6,max:34}},
});

const byId = Object.fromEntries(DATA.nodes.map(n=>[n.id,n]));
const esc = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function render(id){
  const n = byId[id]; const s = document.getElementById('side');
  if(!n){ s.innerHTML=''; return; }
  let h = '<h2 style="color:'+color[n.sub]+'">'+esc(n.label)+'</h2><div class="path">'+esc(n.id)+' · in '+n.in+' / out '+n.out+'</div>';
  if(!n.exports.length) h += '<div class="hint">нет экспортов (или только re-export).</div>';
  for(const e of n.exports){
    if(e.kind==='fn'){
      h += '<div class="exp"><span class="k">fn</span> <span class="n">'+esc(e.name)+'</span>(<span class="sig">'+esc((e.params||[]).join(', '))+'</span>)'+(e.ret?' <span class="sig">: '+esc(e.ret)+'</span>':'')+'</div>';
    } else if(e.kind==='class'){
      h += '<div class="exp"><span class="k">class</span> <span class="n">'+esc(e.name)+'</span>';
      for(const m of e.methods||[]) h += '<div class="meth"><span class="mn">'+esc(m.name)+'</span>('+esc((m.params||[]).join(', '))+')'+(m.ret?': '+esc(m.ret):'')+'</div>';
      h += '</div>';
    } else {
      h += '<div class="exp"><span class="k">'+e.kind+'</span> <span class="n">'+esc(e.name)+'</span></div>';
    }
  }
  s.innerHTML = h;
}
net.on('click', p => { if(p.nodes.length) render(p.nodes[0]); });

// legend + subsystem toggle
const hidden = new Set();
const lg = document.getElementById('legend');
DATA.subs.forEach(sub=>{
  const el = document.createElement('div'); el.className='lg';
  el.innerHTML = '<span class="sw" style="background:'+color[sub]+'"></span>'+sub;
  el.onclick = ()=>{ hidden.has(sub)?hidden.delete(sub):hidden.add(sub); el.style.opacity=hidden.has(sub)?0.35:1;
    nodes.update(DATA.nodes.filter(n=>n.sub===sub).map(n=>({id:n.id,hidden:hidden.has(sub)}))); };
  lg.appendChild(el);
});

// search → focus node OR list matching exports
document.getElementById('search').addEventListener('keydown', ev=>{
  if(ev.key!=='Enter') return;
  const q = ev.target.value.trim().toLowerCase(); if(!q) return;
  let hit = DATA.nodes.find(n=>n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
  if(!hit) hit = DATA.nodes.find(n=>n.exports.some(e=>e.name.toLowerCase().includes(q)));
  if(hit){ net.focus(hit.id,{scale:1.1,animation:true}); net.selectNodes([hit.id]); render(hit.id); }
});
</script></body></html>`;

fs.writeFileSync(OUT, html);
console.log('wrote', path.relative(process.cwd(), OUT));
console.log('files:', data.stats.files, '| imports:', data.stats.edges, '| subsystems:', data.stats.subs);
console.log('subsystems:', data.subs.join(', '));
