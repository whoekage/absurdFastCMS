// uWebSockets.js — a C++ HTTP server (not just WebSockets), usually the fastest Node option.
import uWS from 'uWebSockets.js';
import { buildStringify, buildBuffer } from './data.ts';

const port = Number(process.argv[2] ?? 3005);
const CT = 'application/json; charset=utf-8';
// Fresh, offset-0 byte buffers (uWS reads the raw TypedArray; avoid any pooled-Buffer offset surprise).
const TINY = Uint8Array.from(Buffer.from('{"data":[{"id":1,"title":"x"}],"meta":{"total":1}}', 'utf8'));

uWS
  .App()
  .get('/tiny', (res) => {
    res.writeHeader('Content-Type', CT);
    res.end(TINY);
  })
  .get('/stringify', (res) => {
    res.writeHeader('Content-Type', CT);
    res.end(buildStringify());
  })
  .get('/buffer', (res) => {
    res.writeHeader('Content-Type', CT);
    res.end(Uint8Array.from(buildBuffer())); // copy to an offset-0 view for uWS
  })
  .listen('127.0.0.1', port, (token) => {
    if (token) console.log(`uWS ready on ${port}`);
    else {
      console.error('uWS listen failed');
      process.exit(1);
    }
  });
