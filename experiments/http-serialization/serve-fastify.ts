// Fastify with three strategies: naive stringify, its own fast-json-stringify (schema), and buffer.
import Fastify from 'fastify';
import { buildStringify, buildBuffer, buildObject, responseSchema } from './data.ts';

const port = Number(process.argv[2] ?? 3003);
const app = Fastify({ logger: false });

// We hand Fastify a finished string — isolates framework send overhead, same work as other servers.
app.get('/stringify', (_req, reply) => {
  reply.header('content-type', 'application/json; charset=utf-8').send(buildStringify());
});

// Fastify's signature feature: a response schema makes it serialize via fast-json-stringify.
app.get('/fjs', { schema: { response: { 200: responseSchema } } }, () => buildObject());

app.get('/buffer', (_req, reply) => {
  reply.header('content-type', 'application/json; charset=utf-8').send(buildBuffer());
});

app.listen({ port, host: '127.0.0.1' }, (err) => {
  if (err) throw err;
  console.log(`fastify ready on ${port}`);
});
