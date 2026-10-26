#!/usr/bin/env node
// Builds the static prompt library into dist/ (published by .github/workflows/pages.yml).
//
//   node build.mjs              every top-level folder holding .txt exports
//   node build.mjs leman other  only these folders

import { readdir, readFile, writeFile, mkdir, rm, copyFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { summarize } from './src/parse.js';

const ROOT = new URL('.', import.meta.url).pathname;
const OUT = join(ROOT, 'dist');
const SKIP = new Set(['dist', 'src', 'node_modules']);

async function walk(dir) {
	const out = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.')) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(p)));
		else if (e.name.toLowerCase().endsWith('.txt')) out.push(p);
	}
	return out;
}

async function sourceDirs() {
	const args = process.argv.slice(2);
	if (args.length) return args.map((a) => a.replace(/\/+$/, ''));
	const dirs = [];
	for (const e of await readdir(ROOT, { withFileTypes: true }))
		if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && (await walk(join(ROOT, e.name))).length) dirs.push(e.name);
	return dirs.sort();
}

const dirs = await sourceDirs();
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const sessions = [];
for (const dir of dirs) {
	for (const file of await walk(join(ROOT, dir))) {
		const rel = relative(ROOT, file).split(sep).join('/');
		const text = await readFile(file, 'utf8');
		const dest = join(OUT, 'sessions', rel);
		await mkdir(join(dest, '..'), { recursive: true });
		await copyFile(file, dest);
		const name = rel.split('/').pop();
		sessions.push({
			id: rel.replace(/\.txt$/i, ''),
			dir,
			name,
			path: 'sessions/' + rel,
			bytes: (await stat(file)).size,
			...summarize(text, name)
		});
	}
}
sessions.sort((a, b) => a.dir.localeCompare(b.dir) || b.name.localeCompare(a.name));

await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ built: new Date().toISOString(), dirs, sessions }));
for (const f of ['index.html', 'app.js', 'parse.js']) await copyFile(join(ROOT, 'src', f), join(OUT, f));

console.log(`${sessions.length} sessions from ${dirs.join(', ') || '(none)'} → dist/`);
