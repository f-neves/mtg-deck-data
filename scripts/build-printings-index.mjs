// Gera o índice de IMPRESSÕES (set + número de colecionador) para o scanner do Grimório identificar a
// edição pelo rodapé da carta sem depender da rede. Lê o mesmo bulk "all_cards" do Scryfall que o
// build-card-index.mjs baixa (all_cards.jsonl.gz no diretório atual); se o arquivo não existir,
// baixa.
//
// Saída:
//  - printings.ndjson.gz : uma linha JSON por registro, discriminador no índice 0:
//       ["p", set, number, oracleId, englishName, scryfallId, langs, finishes, border, frame,
//             effects, rarity, year]
//         langs    = idiomas em que a impressão existe, separados por vírgula ("en,pt,ja")
//         finishes = acabamentos somados de todos os idiomas ("nonfoil,foil,etched")
//         effects  = frame_effects + promo_types, separados por "|" ("showcase|serialized")
//       ["s", set, printedSize, setName, releasedAt]
//         printedSize = total impresso na carta (o "/280"), para casar cartas de 2003 a 2022.
//  - printings-manifest.json : { version, generatedAt, rows, sets, bytes, sha256, url }
//
// Uso: node scripts/build-printings-index.mjs   (Node 20+; sem dependências)

import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';

const UA = 'MTGDecksApp-indexer/1.0 (app pessoal; contato neves.mecanica@gmail.com)';
const BULK_FILE = process.env.BULK_FILE || 'all_cards.jsonl.gz';
const OUT_FILE = 'printings.ndjson.gz';
const MANIFEST_FILE = 'printings-manifest.json';
const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

async function* gzLines(file) {
  const src = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const rl = createInterface({ input: src, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) yield line;
  }
}

async function* cardsOfBulk() {
  for await (const raw of gzLines(BULK_FILE)) {
    const line = raw.endsWith(',') ? raw.slice(0, -1) : raw;
    if (line === '[' || line === ']') continue;
    yield JSON.parse(line);
  }
}

async function bulkMeta() {
  const meta = await (await fetch('https://api.scryfall.com/bulk-data', { headers: { 'User-Agent': UA } })).json();
  const all = (meta.data ?? []).find((b) => b.type === 'all_cards');
  if (!all) throw new Error('bulk all_cards não encontrado');
  return all;
}

const cp = (s) => (s == null ? null : Buffer.from(String(s), 'utf8').toString('utf8'));

async function main() {
  let version = process.env.BULK_VERSION || null;
  if (!existsSync(BULK_FILE)) {
    const all = await bulkMeta();
    version = all.updated_at;
    const url = all.jsonl_download_uri ?? all.download_uri;
    console.log('Baixando bulk', url);
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error('download do bulk: ' + resp.status);
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(BULK_FILE));
  } else if (!version) {
    try {
      version = (await bulkMeta()).updated_at;
    } catch {
      version = new Date().toISOString();
    }
  }

  // set|número → registro agregado entre idiomas
  const prints = new Map();
  const sets = new Map(); // set → { size, name, released }
  let scanned = 0;
  for await (const c of cardsOfBulk()) {
    scanned++;
    if (c.digital || SKIP_LAYOUTS.has(c.layout) || !c.set || !c.collector_number) continue;
    const key = `${c.set}|${c.collector_number}`;
    let p = prints.get(key);
    if (!p) {
      p = {
        set: cp(c.set),
        number: cp(c.collector_number),
        oracle: cp(c.oracle_id ?? c.card_faces?.[0]?.oracle_id ?? null),
        name: cp(c.name),
        id: cp(c.id),
        idIsEn: c.lang === 'en',
        langs: new Set(),
        finishes: new Set(),
        border: cp(c.border_color ?? null),
        frame: cp(c.frame ?? null),
        effects: cp([...(c.frame_effects ?? []), ...(c.promo_types ?? [])].join('|') || null),
        rarity: cp(c.rarity ?? null),
        year: c.released_at ? Number(c.released_at.slice(0, 4)) : null,
      };
      prints.set(key, p);
    }
    p.langs.add(cp(c.lang));
    for (const f of c.finishes ?? []) p.finishes.add(f);
    if (c.lang === 'en' && !p.idIsEn) {
      p.id = cp(c.id);
      p.idIsEn = true;
    }
    if (!sets.has(c.set)) sets.set(c.set, { size: c.printed_size ?? null, name: cp(c.set_name), released: cp(c.released_at ?? null) });
    if (scanned % 100000 === 0) console.log('…', scanned, 'cartas lidas,', prints.size, 'impressões');
  }

  // Tamanho impresso do set: o bulk não traz; vem do /sets.
  try {
    const sres = await (await fetch('https://api.scryfall.com/sets', { headers: { 'User-Agent': UA } })).json();
    for (const s of sres.data ?? []) {
      const cur = sets.get(s.code);
      if (cur) cur.size = s.printed_size ?? s.card_count ?? null;
    }
  } catch (e) {
    console.warn('sem /sets:', e.message);
  }

  const gz = createGzip({ level: 9 });
  const out = createWriteStream(OUT_FILE);
  gz.pipe(out);
  const write = async (arr) => {
    if (!gz.write(JSON.stringify(arr) + '\n')) await once(gz, 'drain');
  };
  const keys = [...prints.keys()].sort();
  for (const k of keys) {
    const p = prints.get(k);
    await write([
      'p', p.set, p.number, p.oracle, p.name, p.id, [...p.langs].sort().join(','),
      [...p.finishes].sort().join(','), p.border, p.frame, p.effects, p.rarity, p.year,
    ]);
  }
  for (const [code, s] of [...sets.entries()].sort()) await write(['s', code, s.size, s.name, s.released]);
  gz.end();
  await once(out, 'finish');

  const buf = readFileSync(OUT_FILE);
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    rows: prints.size,
    sets: sets.size,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    url: OUT_FILE,
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  console.log('Impressões:', prints.size, '| sets:', sets.size, '| bytes:', buf.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
