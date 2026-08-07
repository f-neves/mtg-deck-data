// Gera o índice slim de nomes de carta (Eixo 1, Fase 3) a partir do bulk "all_cards" do Scryfall.
// Roda no CI (GitHub Actions). Mantém só nome/idioma/oracle_id dos 6 idiomas de alfabeto latino +
// uma impressão representativa por carta (p/ o app montar um CardResult e cadastrar offline).
//
// Saída:
//  - card-index.ndjson.gz : uma linha JSON por registro. Array com discriminador no índice 0:
//       ["c", oracleId, englishName, scryfallId, set, collectorNumber, setName, imageUri,
//             manaValue, typeLine, colors, colorIdentity, layout]
//       ["n", nameNorm, lang, oracleId, displayName]
//  - card-index-delta.ndjson.gz : só as linhas que mudaram desde o índice publicado anterior, p/ o
//       app não rebaixar tudo toda semana. Mesmo formato de linha do arquivo completo.
//  - manifest.json : { version, generatedAt, cards, names, bytes, sha256, url,
//       deltaFrom, deltaUrl, deltaBytes, deltaLines, deltaSha256 }
//
// Sem deps externas: o bulk do Scryfall é JSON Lines gzipado (uma carta por linha), então basta
// gunzip + readline. (Até 2026-08 era um array JSON gigante e o gerador usava stream-json; o
// Scryfall trocou `download_uri` por `jsonl_download_uri` e o build quebrou. Ver leitura tolerante
// em `linesOfBulk`.)
// Requer Node 20+ (fetch e Readable.fromWeb globais).

import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';

const UA = 'MTGDecksApp-indexer/1.0 (app pessoal; contato neves.mecanica@gmail.com)';
const LATIN = new Set(['en', 'pt', 'es', 'fr', 'de', 'it']);
const BULK_FILE = 'all_cards.jsonl.gz';
const INDEX_FILE = 'card-index.ndjson.gz';
const DELTA_FILE = 'card-index-delta.ndjson.gz';
// Índice publicado no build anterior, baixado pelo workflow (ausente na primeira vez).
const PREV_FILE = 'prev-card-index.ndjson.gz';
const PREV_MANIFEST = 'prev-manifest.json';
// Acima disto o delta não compensa (o app baixaria quase o mesmo peso); manda baixar o completo.
const MAX_DELTA_RATIO = 0.6;

// Mesma normalização do app (src/textNormalize.ts) — os lookups locais dependem disso bater.
function normalizeName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Cópia forte de string. Um valor tirado do JSON pode ser uma FATIA (sliced string) do texto de
// origem; reter uma fatiazinha (num Set/Map) mantém o texto INTEIRO vivo. Multiplicado por dezenas de
// milhares de oracles isso estoura a memória (causa dos OOM dos primeiros builds). O round-trip por
// Buffer cria uma string independente. Aplicar a TUDO que for retido.
const cp = (s) => (s == null ? null : Buffer.from(s, 'utf8').toString('utf8'));

function imgOf(c) {
  if (c.image_uris) return c.image_uris.small ?? c.image_uris.normal ?? null;
  const f = c.card_faces?.[0];
  return f?.image_uris?.small ?? f?.image_uris?.normal ?? null;
}
function wubrg(arr) {
  if (!arr) return null;
  const order = ['W', 'U', 'B', 'R', 'G'];
  return order.filter((x) => arr.includes(x)).join('');
}
function typeLineOf(c) {
  if (c.type_line) return c.type_line;
  const f = c.card_faces?.map((x) => x.type_line).filter(Boolean);
  return f && f.length ? f.join(' // ') : null;
}
// Nome impresso no idioma da carta (en = o próprio name; senão printed_name ou faces). null = sem
// tradução (o registro em inglês já cobre).
function printedName(c) {
  if (c.lang === 'en') return c.name;
  if (c.printed_name) return c.printed_name;
  const f = c.card_faces?.map((x) => x.printed_name).filter(Boolean);
  return f && f.length ? f.join(' // ') : null;
}
// Nomes IMPRESSOS na carta que diferem do nome oracle e precisam casar no reconhecimento:
//  1) flavor_name (Secret Lair/Godzilla/Final Fantasy): "Golbez, Clad In Darkness" p/ Syr Konrad.
//  2) printed_name numa carta EM INGLÊS (Universes Beyond): "Dhalsim, Pliable Pacifist" p/ Tadeas.
// Cada um vira um name_norm extra apontando pro MESMO oracle, com display = o próprio nome impresso.
function altNames(c) {
  const out = [];
  if (c.flavor_name) out.push(c.flavor_name);
  const faceFlavor = c.card_faces?.map((x) => x.flavor_name).filter(Boolean);
  if (faceFlavor && faceFlavor.length) out.push(faceFlavor.join(' // '));
  if (c.lang === 'en' && c.printed_name && normalizeName(c.printed_name) !== normalizeName(c.name)) {
    out.push(c.printed_name);
  }
  return out;
}
// Quão boa é esta impressão p/ ser a representativa (tem imagem, é em inglês, é de papel).
function reprScore(c) {
  let s = 0;
  if (imgOf(c)) s += 2;
  if (c.lang === 'en') s += 1;
  if (!c.digital) s += 1;
  return s;
}

// Linhas de um arquivo de texto, descompactando em fluxo se terminar em .gz (o bulk tem ~390MB
// comprimido e vários GB abertos, não cabe em memória).
async function* gzLines(file) {
  const src = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const rl = createInterface({ input: src, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) yield line;
  }
}

// Cartas do bulk salvo em disco. Tolerante ao formato antigo em array JSON: descarta os colchetes
// soltos e a vírgula do fim da linha.
async function* linesOfBulk() {
  for await (const raw of gzLines(BULK_FILE)) {
    const line = raw.endsWith(',') ? raw.slice(0, -1) : raw;
    if (line === '[' || line === ']') continue;
    yield JSON.parse(line);
  }
}

/**
 * Delta em relação ao índice publicado no build anterior: as linhas do índice novo que não existiam
 * no antigo (carta nova, tradução nova, impressão representativa trocada). Como cada linha é um
 * array serializado de forma estável, comparar texto puro basta.
 *
 * O arquivo é sempre escrito (mesmo vazio) p/ o passo de publicação não falhar; quem decide se o
 * delta vale é o manifest. Deleção não viaja no delta: nome que sai do Scryfall (raríssimo) só some
 * do aparelho no próximo índice completo.
 *
 * Retorna null quando não há base de comparação ou quando o delta não compensa.
 */
async function buildDelta() {
  const out = createWriteStream(DELTA_FILE);
  const gz = createGzip({ level: 6 });
  gz.pipe(out);

  let from = null;
  if (existsSync(PREV_FILE) && existsSync(PREV_MANIFEST)) {
    try {
      from = JSON.parse(readFileSync(PREV_MANIFEST, 'utf8')).version ?? null;
    } catch {
      from = null; // manifest anterior ilegível: sem delta, o app baixa o completo
    }
  }

  let lines = 0;
  if (from) {
    const prev = new Set();
    for await (const line of gzLines(PREV_FILE)) prev.add(line);
    console.log('Índice anterior:', prev.size, 'linhas (versão', from + ')');
    for await (const line of gzLines(INDEX_FILE)) {
      if (prev.has(line)) continue;
      if (!gz.write(line + '\n')) await once(gz, 'drain');
      lines++;
    }
  }
  gz.end();
  await once(out, 'finish');

  if (!from) return null;
  const buf = readFileSync(DELTA_FILE);
  const full = readFileSync(INDEX_FILE).length;
  if (buf.length > full * MAX_DELTA_RATIO) {
    console.log('Delta grande demais (', buf.length, 'de', full, 'bytes) — anunciando só o completo.');
    return null;
  }
  return { from, lines, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function main() {
  // 1) Metadados do bulk (URI de download + updated_at = versão).
  const meta = await (await fetch('https://api.scryfall.com/bulk-data', { headers: { 'User-Agent': UA } })).json();
  const all = (meta.data ?? []).find((b) => b.type === 'all_cards');
  if (!all) throw new Error('bulk all_cards não encontrado');
  // O campo é `jsonl_download_uri` desde ago/2026; `download_uri` fica de reserva p/ o formato antigo.
  const url = all.jsonl_download_uri ?? all.download_uri;
  if (!url) throw new Error('bulk all_cards sem URI de download: ' + JSON.stringify(Object.keys(all)));
  const version = all.updated_at;
  console.log('Versão do bulk:', version, '→ baixando', url);

  // 2) Baixa o bulk p/ disco (não cabe em memória).
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error('download do bulk: ' + resp.status);
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(BULK_FILE));
  console.log('Bulk salvo. Processando…');

  // 3) Stream-parse: coleta impressão representativa por oracle_id + emite nomes (dedup) na hora.
  const gz = createGzip({ level: 6 }); // 6 comprime quase igual ao 9 e drena bem mais rápido
  const out = createWriteStream(INDEX_FILE);
  gz.pipe(out);
  // Respeita backpressure: se o buffer encher, espera 'drain' antes de continuar. Sem isso o buffer
  // de escrita cresce sem limite e o Node estoura o heap (causa do OOM no 1o build).
  const writeLine = async (arr) => {
    if (!gz.write(JSON.stringify(arr) + '\n')) await once(gz, 'drain');
  };

  const index = new Map(); // oracle_id → { score, card-fields }
  const seenName = new Set(); // `${oracle}|${lang}|${norm}` p/ não repetir
  let nameCount = 0;
  let scanned = 0;

  // Processa uma carta. Async: o backpressure vem do Writable abaixo (só pede a próxima quando esta
  // termina), então o parser não lê o arquivo inteiro p/ a memória (causa dos OOM anteriores).
  async function handleCard(c) {
    scanned++;
    if ((scanned % 100000) === 0) {
      const rss = Math.round(process.memoryUsage().rss / 1e6);
      const heap = Math.round(process.memoryUsage().heapUsed / 1e6);
      console.log(`  ... ${scanned} cartas | nomes ${nameCount} | oracles ${index.size} | seen ${seenName.size} | RSS ${rss}MB heap ${heap}MB`);
    }
    const oracle = c.oracle_id;
    if (!oracle || !c.name || !LATIN.has(c.lang)) return;
    // Cópia independente: o oracle_id vira chave do Map/Set, então NÃO pode ser uma fatia do bloco.
    const oid = cp(oracle);

    // Nome no idioma da carta (e sempre o inglês, via lang en). O `key` é template literal (já achata),
    // e o que vai pro gz é serializado na hora (não retido) — só `oid` precisa de cópia aqui.
    const disp = printedName(c);
    if (disp) {
      // Nome inteiro + cada FACE (cartas "//": dupla face, split, adventure). O OCR lê só uma face, e
      // sozinha ela é curta demais p/ casar com o nome completo — então cada face vira um name_norm
      // próprio apontando pro mesmo oracle, mas com display = nome COMPLETO (o que se salva).
      const variants = disp.includes('//')
        ? [disp, ...disp.split('//').map((s) => s.trim()).filter(Boolean)]
        : [disp];
      for (const v of variants) {
        const norm = normalizeName(v);
        if (!norm) continue;
        const key = `${oid}|${c.lang}|${norm}`;
        if (!seenName.has(key)) {
          seenName.add(key);
          await writeLine(['n', norm, c.lang, oid, disp]); // display = nome completo
          nameCount++;
        }
      }
    }

    // Nomes de sabor / Universes Beyond impressos na carta (Golbez, Dhalsim…): cada um casa com o
    // mesmo oracle, mas com display = o próprio nome impresso (o que se salva ao reconhecer).
    for (const alt of altNames(c)) {
      const variants = alt.includes('//')
        ? [alt, ...alt.split('//').map((s) => s.trim()).filter(Boolean)]
        : [alt];
      for (const v of variants) {
        const norm = normalizeName(v);
        if (!norm) continue;
        const key = `${oid}|${c.lang}|${norm}`;
        if (!seenName.has(key)) {
          seenName.add(key);
          await writeLine(['n', norm, c.lang, oid, alt]); // display = nome impresso na carta
          nameCount++;
        }
      }
    }

    // Impressão representativa (a de maior score por oracle_id). TUDO que fica no Map é cópia forte
    // (cp), senão cada campo prende um bloco de 64KB do parser e a memória estoura.
    const score = reprScore(c);
    const prev = index.get(oid);
    if (!prev || score > prev.score) {
      index.set(oid, {
        score,
        e: cp(c.name),
        sid: cp(c.id),
        set: cp(c.set),
        num: cp(c.collector_number),
        sn: cp(c.set_name),
        img: cp(imgOf(c)),
        mv: typeof c.cmc === 'number' ? c.cmc : null,
        tl: cp(typeLineOf(c)),
        co: wubrg(c.colors),
        ci: wubrg(c.color_identity),
        ly: cp(c.layout),
      });
    }
  }

  // Backpressure natural: o `for await` só puxa a próxima linha quando a carta atual terminou de ser
  // processada (e o writeLine espera 'drain' se o gz encher), então a memória fica limitada.
  for await (const c of linesOfBulk()) {
    await handleCard(c);
  }

  // 4) Emite o índice (impressões representativas).
  for (const [oracle, r] of index) {
    await writeLine(['c', oracle, r.e, r.sid, r.set, r.num, r.sn, r.img, r.mv, r.tl, r.co, r.ci, r.ly]);
  }
  gz.end();
  await new Promise((res, rej) => out.on('finish', res).on('error', rej));

  // 5) Delta em relação ao índice publicado anterior (se o workflow baixou um).
  const delta = await buildDelta();

  // 6) Manifest (versão + hash p/ o app decidir se baixa).
  const buf = readFileSync(INDEX_FILE);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    cards: index.size,
    names: nameCount,
    bytes: buf.length,
    sha256,
    url: INDEX_FILE,
    // Atualização incremental: só vale p/ quem está EXATAMENTE na versão `deltaFrom`; os outros
    // baixam o completo. `null` = sem delta neste build (primeira vez, ou delta grande demais p/
    // compensar).
    deltaFrom: delta?.from ?? null,
    deltaUrl: delta ? DELTA_FILE : null,
    deltaBytes: delta?.bytes ?? null,
    deltaLines: delta?.lines ?? null,
    deltaSha256: delta?.sha256 ?? null,
  };
  writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
  console.log('Pronto:', manifest.cards, 'cartas,', manifest.names, 'nomes,', (buf.length / 1e6).toFixed(1), 'MB');
  if (delta) {
    console.log(
      `Delta desde ${delta.from}: ${delta.lines} linhas, ${(delta.bytes / 1e3).toFixed(0)} KB ` +
        `(${((delta.bytes / buf.length) * 100).toFixed(1)}% do completo)`
    );
  } else {
    console.log('Sem delta neste build (o app baixa o índice completo).');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
