// Driver for the markdown-render-speed-02 entry.
// Reads every case from the input directory, renders each one alone with
// parse() from ./parse.js, and writes the HTML array to the output directory.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };
const cases: Case[] = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
