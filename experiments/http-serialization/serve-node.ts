// node:http baseline — the zero-dependency throughput ceiling.
import http from 'node:http';
import { buildStringify, buildBuffer } from './data.ts';

const port = Number(process.argv[2] ?? 3001);
const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };
// ~50-byte static response — isolates the framework's true req/s ceiling (no payload-byte cost).
const TINY = Buffer.from('{"data":[{"id":1,"title":"x"}],"meta":{"total":1}}', 'utf8');

const server = http.createServer((req, res) => {
  if (req.url === '/tiny') {
    res.writeHead(200, { ...JSON_CT, 'content-length': TINY.length });
    res.end(TINY);
  } else if (req.url === '/stringify') {
    const s = buildStringify();
    res.writeHead(200, { ...JSON_CT, 'content-length': Buffer.byteLength(s) });
    res.end(s);
  } else if (req.url === '/buffer') {
    const b = buildBuffer();
    res.writeHead(200, { ...JSON_CT, 'content-length': b.length });
    res.end(b);
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(port, () => console.log(`node:http ready on ${port}`));
