// Hono on the Node adapter.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { buildStringify, buildBuffer } from './data.ts';

const port = Number(process.argv[2] ?? 3002);
const app = new Hono();
const TINY = Buffer.from('{"data":[{"id":1,"title":"x"}],"meta":{"total":1}}', 'utf8');

app.get('/tiny', (c) => {
  c.header('content-type', 'application/json; charset=utf-8');
  return c.body(TINY);
});

app.get('/stringify', (c) => {
  c.header('content-type', 'application/json; charset=utf-8');
  return c.body(buildStringify());
});
app.get('/buffer', (c) => {
  c.header('content-type', 'application/json; charset=utf-8');
  return c.body(buildBuffer());
});

serve({ fetch: app.fetch, port }, () => console.log(`hono ready on ${port}`));
