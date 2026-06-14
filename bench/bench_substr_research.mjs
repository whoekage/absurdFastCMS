// Empirical: brute-force substring scan over dictionary-encoded string column in V8/Node
// Simulate a CMS string column: distinct values (dictionary), avg length ~40 chars
const N_DISTINCT = 200_000;       // distinct dictionary entries
const AVG_LEN = 40;
const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
function randStr(len){ let s=''; for(let i=0;i<len;i++) s+=chars[(Math.random()*chars.length)|0]; return s; }

// Build dictionary of JS strings
const dict = new Array(N_DISTINCT);
for (let i=0;i<N_DISTINCT;i++) dict[i] = randStr(20 + (Math.random()*40|0));

// Also build a single flat Buffer (UTF8/ASCII) with offsets for raw-byte scan
const parts = [];
const offsets = new Int32Array(N_DISTINCT+1);
let total=0;
for (let i=0;i<N_DISTINCT;i++){ const b=Buffer.from(dict[i],'latin1'); parts.push(b); offsets[i]=total; total+=b.length; }
offsets[N_DISTINCT]=total;
const flat = Buffer.concat(parts);
console.log('distinct=',N_DISTINCT,'flatBytes=',(total/1e6).toFixed(1),'MB');

const needle = 'xq7'; // rare-ish trigram-sized needle
const needleLower = needle.toLowerCase();

function benchJsIncludes(){
  let hits=0; const t=process.hrtime.bigint();
  for (let i=0;i<N_DISTINCT;i++) if (dict[i].includes(needle)) hits++;
  const ms = Number(process.hrtime.bigint()-t)/1e6;
  return {ms,hits};
}
function benchJsIncludesCI(){
  let hits=0; const t=process.hrtime.bigint();
  // case-insensitive WITHOUT precompute: toLowerCase per value (worst case)
  for (let i=0;i<N_DISTINCT;i++) if (dict[i].toLowerCase().includes(needleLower)) hits++;
  const ms = Number(process.hrtime.bigint()-t)/1e6;
  return {ms,hits};
}
function benchBufferIndexOf(){
  // single big buffer scan (memmem-style, but crosses value boundaries -> needs offset map for real use)
  let count=0; const t=process.hrtime.bigint();
  let idx = flat.indexOf(needle,0,'latin1');
  while(idx!==-1){ count++; idx = flat.indexOf(needle, idx+1, 'latin1'); }
  const ms = Number(process.hrtime.bigint()-t)/1e6;
  return {ms,count};
}

// warm up JIT
for(let k=0;k<3;k++){ benchJsIncludes(); benchBufferIndexOf(); }

const a=benchJsIncludes();
const b=benchJsIncludesCI();
const c=benchBufferIndexOf();
console.log('JS .includes()         ', a.ms.toFixed(1),'ms  hits=',a.hits, ' =>', (N_DISTINCT/a.ms/1000).toFixed(1),'M values/s', (total/a.ms/1e6).toFixed(2),'GB/s');
console.log('JS .toLowerCase+incl CI', b.ms.toFixed(1),'ms  hits=',b.hits, ' =>', (N_DISTINCT/b.ms/1000).toFixed(1),'M values/s');
console.log('Buffer.indexOf flat    ', c.ms.toFixed(1),'ms  count=',c.count, ' =>', (total/c.ms/1e6).toFixed(2),'GB/s');
