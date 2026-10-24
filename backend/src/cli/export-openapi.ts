/** Write the OpenAPI document to docs/openapi.json without starting a server. */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { buildApp } from '../app.js';

const config = { ...loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused@localhost/unused' }), enableDocs: true, logLevel: 'silent' };
const db = createPool(config.databaseUrl, 1); // not connected unless queried
const app = await buildApp({ config, db });
await app.ready();
const out = path.resolve(process.argv[2] ?? '../docs/openapi.json');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(app.swagger(), null, 2) + '\n');
console.log(`OpenAPI written to ${out}`);
await app.close();
await db.end();
