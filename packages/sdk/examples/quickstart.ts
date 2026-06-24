// @conti/sdk — QUICKSTART example.
//
// Defines a content-type at runtime, writes a couple of rows (incl. wire-fidelity values), then
// queries them back — exercising the Builder, write, and read paths end to end.
//
// Runnable ESM TypeScript (type-strips under Node >= 24, no build step):
//
//   node packages/sdk/examples/quickstart.ts
//
// Point it at a live @conti/api server started WITH a store + registry (the Builder routes are only
// mounted then). Override the URL with BASE_URL; defaults to http://127.0.0.1:3000.

import { createClient, ConflictError, type Entry } from '@conti/sdk';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const client = createClient({ baseUrl });

// A row type — used to type both writes and reads of this collection. It `extends Entry` (an open
// record) so it satisfies the `T extends Entry` constraint on the read/write methods.
interface Product extends Entry {
  id: number;
  name: string;
  price: string; // decimal → lossless wire string (never a JS number)
  inStock: boolean;
  sku: string;
}

async function main(): Promise<void> {
  // 1) Define the content-type at runtime (idempotent for re-runs: ignore "already exists").
  try {
    const def = await client.contentTypes.create({
      apiId: 'product',
      fields: [
        { name: 'name', cmsType: 'string', options: { length: 200 } },
        { name: 'price', cmsType: 'decimal', options: { precision: 12, scale: 2 } },
        { name: 'inStock', cmsType: 'boolean', options: { default: true } },
        { name: 'sku', cmsType: 'uid' },
      ],
    });
    console.log('created type:', def.apiId, def.fields.map((f) => f.name).join(', '));
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    console.log('type "product" already exists — reusing it');
  }

  // Bind a typed collection so we stop repeating the api_id and the row type.
  const products = client.collection<Product>('product');

  // 2) Create rows. `price` is a STRING (decimal is lossless on the wire — never a JS number).
  const created = await products.create({
    name: 'Absurdly Fast Mug',
    price: '19.99',
    inStock: true,
    sku: `mug-${Date.now()}`,
  });
  console.log('created row id:', created.data.id);

  // 3) Read it back by id.
  const fetched = await products.findOne(created.data.id);
  console.log('read back:', fetched.data.name, '@', fetched.data.price);

  // 4) Partial update (Strapi semantics — only the listed keys are touched).
  await products.update(created.data.id, { inStock: false });

  // 5) Query: in-stock products under $50, cheapest first.
  const cheap = await products.list({
    filters: { inStock: { $eq: true }, price: { $lte: '50.00' } },
    sort: 'price:asc',
    pagination: { pageSize: 10 },
  });
  console.log('in-stock under $50:', cheap.data.length, 'of', cheap.meta.pagination);

  // 6) Count without fetching rows.
  const total = await products.count();
  console.log('total products:', total);

  // 7) Clean up the row we created (leave the type in place for re-runs).
  await products.delete(created.data.id);
  console.log('deleted row', created.data.id);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
