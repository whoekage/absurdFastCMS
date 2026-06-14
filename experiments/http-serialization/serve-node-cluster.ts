// Clustered node:http — N workers share one port (Node round-robins connections), so the
// server uses many cores instead of one. Shows the machine's aggregate ceiling.
import cluster from 'node:cluster';
import http from 'node:http';
import { buildBuffer } from './data.ts';

const port = Number(process.argv[2] ?? 3004);
const workers = Number(process.argv[3] ?? 6);
const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };
const TINY = Buffer.from('{"data":[{"id":1,"title":"x"}],"meta":{"total":1}}', 'utf8');

if (cluster.isPrimary) {
  for (let i = 0; i < workers; i++) cluster.fork();
  console.log(`cluster primary: ${workers} workers on ${port}`);
} else {
  const server = http.createServer((req, res) => {
    if (req.url === '/tiny') {
      res.writeHead(200, { ...JSON_CT, 'content-length': TINY.length });
      res.end(TINY);
    } else if (req.url === '/buffer') {
      const b = buildBuffer();
      res.writeHead(200, { ...JSON_CT, 'content-length': b.length });
      res.end(b);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port);
}
