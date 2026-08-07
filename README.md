# Grimório · dados públicos

Arquivos que o app **Grimório** (catálogo de cartas de Magic: the Gathering) baixa pronto. O código
do app é fechado e mora em outro repositório; aqui fica só o que precisa ser público para o aparelho
alcançar sem login.

## O que tem aqui

### Índice de nomes de carta (`card-index`)

Lista local de nomes usada pelo scanner para reconhecer a carta na hora, offline e tolerando erro de
leitura. Gerada do [bulk data do Scryfall](https://scryfall.com/docs/api/bulk-data) e publicada como
**release de tag fixa `card-index`**:

| arquivo | o que é |
|---|---|
| `card-index.ndjson.gz` | pacote completo (~12 MB): uma impressão representativa por carta + todos os nomes normalizados em 6 idiomas de alfabeto latino (en, pt, es, fr, de, it) |
| `card-index-delta.ndjson.gz` | só o que mudou desde o build anterior, para o app não rebaixar tudo toda semana |
| `manifest.json` | versão, contagens, hashes e de qual versão o delta parte (`deltaFrom`) |

Formato de cada linha (array JSON com discriminador na posição 0):

```
["c", oracleId, englishName, scryfallId, set, collectorNumber, setName, imageUri,
      manaValue, typeLine, colors, colorIdentity, layout]
["n", nameNorm, lang, oracleId, displayName]
```

O gerador é `scripts/build-card-index.mjs` (Node 20+, sem dependências) e roda pelo workflow
`Build card index`: **toda segunda, 06:17 UTC**, e sob demanda. O app checa o `manifest.json` no
máximo 1x por dia; se a versão local for exatamente o `deltaFrom`, baixa só o delta, senão baixa o
pacote completo.

### Política de privacidade

`docs/privacy-policy.html`, servida pelo GitHub Pages em
<https://f-neves.github.io/mtg-deck-data/privacy-policy.html>. É o endereço declarado na ficha da
Google Play.

## Dados de carta

Vêm do Scryfall, que os disponibiliza sem custo. Nomes de carta, textos e imagens de Magic: the
Gathering são marcas e material protegido da Wizards of the Coast; este repositório não é afiliado
nem endossado por ela.
