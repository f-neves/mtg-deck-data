# Estudo · como a LigaMagic entrega preço de carta

Data: 2026-11-02. Fontes: o HAR `download` (página da Counterspell, logado), os bundles JS que vieram
nele, testes com `curl`/`curl_cffi`/Playwright e navegação manual no Chrome logado.

## Resumo em 6 linhas

1. Não há API pública. Todo o dado de preço vem **embutido no HTML** das páginas (`var ... = [...]`).
   A página não faz nenhuma chamada XHR para montar a lista de preços.
2. A página de uma carta traz **todas as impressões dela de uma vez**, com preço mínimo, médio e máximo
   em BRL **separado por acabamento** (normal, foil, foil etched, etc.). É exatamente o que o Grimório precisa.
3. As páginas HTML estão atrás de um **desafio interativo do Cloudflare (Turnstile)**. curl, curl_cffi
   imitando Chrome, Playwright headless e até o Chrome real controlado por automação caem no
   "Confirme que é humano". Só o navegador de uma pessoa passa.
4. O `robots.txt` pede `Crawl-delay: 360` (uma requisição a cada 6 minutos) e bloqueia
   explicitamente o crawler de renderização do Cloudflare. Somando com o item 3: o site não quer robô.
5. Fora do Cloudflare ficam: a busca de nomes (`clubedaliga.com.br/api/cardsearch`, com CORS liberado)
   e os `/ajax/*.php`. Nenhum desses entrega preço para usuário anônimo.
6. Casar a impressão da Liga com o `scryfall_id` do app funciona por regra + tabela pequena:
   65 de 87 impressões da Counterspell (75%) no pior caso; as que sobram são Pro Tour / World
   Championship (borda dourada) e promos raros.

## 1. Mapa de endpoints

### Páginas HTML (todas atrás do Cloudflare Turnstile)

| URL | O que entrega |
|---|---|
| `/?view=cards/card&card=<nome>` | Carta: todas as impressões + preços + ofertas de lojas. **A principal.** Aceita nome em inglês ou português. |
| `/?view=cards/search&card=ed=<codigo>` | Edição inteira: `var cardsjson` com uma linha por carta (391 em MH2), preço só do **normal**. |
| `/?view=cards/edicoes` | Lista de edições (não capturada ainda, serve para montar a tabela de códigos). |
| `/?view=cards/pricehistory&card=<nome>` | Histórico de preço. Proibido no `robots.txt` e com Cloudflare mais rígido: até o Chrome logado recebeu o desafio. |

Os parâmetros `ed=`, `num=` e `edid=` na página da carta são ignorados (testado: `param.card.edition`
fica vazio). Não faz diferença, porque a página já traz todas as edições.

### Endpoints sem desafio

| Endpoint | Uso | Situação |
|---|---|---|
| `GET https://www.clubedaliga.com.br/api/cardsearch?tcg=1&query=<texto>&maxQuantity=8` | Autocomplete de nomes (PT e EN). | **Funciona anônimo**, `Access-Control-Allow-Origin: *`, cache de 48 h. Sem `maxQuantity` responde `[]`. |
| `GET /ajax/mp/marketplace.php?opc=latestsales&tcg=1&card_id=<id>&card_ed=&card_num=&filter_set=<edId_cardId>&filter_cond=-1&filter_extras=-1&filter_period=2&has_extras=1` | Últimas vendas (vendas reais, gráfico). | Responde `[]` anônimo e também logado fora da página de histórico. |
| `POST /ajax/cards/main.php` `opc=nextPage` | Paginação da busca. | Não testado a fundo. |
| `/ajax/mp/actions.php`, `/ajax/mp/carrinho.php`, `/ajax/bzr/cards.php`, `/ajax/colecao/cards.php`, `/ajax/mp/alerta_get.php`, `/ajax/mp/alerta_put.php` | Loja, carrinho, bazar, coleção, alertas de preço. | Exigem sessão; ações com efeito colateral. Não usar. |

Exemplo do autocomplete:

```json
{"query":"Contramagica","suggestions":["Counterspell","Counterspell (#7010)"],
 "data":[{"__key":"marketplace:cards:tcg1:4220_1","sNomeIdiomaPrincipal":"Contram&aacute;gica",
          "sNomeIdiomaSecundario":"Counterspell", ...}]}
```

O número em `__key` (`4220`) é o id da carta na Liga. Variantes com nome próprio ganham outro id
(`77489` = Counterspell #7010, do Secret Lair do Bob Esponja).

## 2. O que vem dentro da página da carta

Um único `<script>` de ~540 KB declara:

| Variável | Conteúdo |
|---|---|
| `cards_editions` | Uma entrada por impressão (87 na Counterspell). **É daqui que sai o preço.** |
| `cards_stock` | Cada anúncio de loja (1270 na Counterspell): preço, qualidade, idioma, extras, UF. |
| `cards_stores` | Dados das lojas (nome, cidade, reputação, telefone). |
| `dataLanguage`, `dataQuality`, `dataExtras` | Tabelas de domínio (ids de idioma, condição e extras). |
| `param` | `card.id`, edição padrão, se está logado. |

### `cards_editions[]`

```json
{"id":479849, "idkey":"479849_267", "idcard":4220, "name":"Modern Horizons 2",
 "code":"mh2", "num":"267", "artist":"Zack Stella", "ntl":0, "date":"2021-06-11 00:00:00",
 "rarid":{"code":2,"acron":"U"},
 "price":{"0":{"p":"13.90","m":"21.93","g":"31.00"},
          "2":{"p":"24.00","m":"32.89","g":"38.00"},
          "31":{"p":"25.00","m":"30.00","g":"36.00"}}}
```

- `price` é indexado pelo id de `dataExtras`: `0` normal, `2` foil, `31` foil especial/etched,
  `3` promo, `17` assinada, `37` misprint, `41` miscut etc.
- `p` / `m` / `g` = **menor / médio / maior** das ofertas atuais (conferido com o modal
  "Preço Médio por Extras" da própria página). Não é preço de venda concluída.
- Quando `price` é uma lista (`[{"p":..}]`) só existe o normal. `[]` dentro de uma chave = sem oferta.
- Esquisitices: `m` às vezes vem `"0.00"` com `p` e `g` preenchidos, e houve caso de `g < m`.
  Tratar `0.00` como ausente.
- `ntl` parece ser "não legal em torneio" (aparece em 30A, WCD, CED). É inferência minha.
- `code` + `num` identificam a impressão. `id` é a edição na Liga; várias impressões podem
  compartilhar o mesmo `id` (as 10 versões de WCD, por exemplo).

### `cards_stock[]` (anúncios)

Campos úteis: `preco`, `precoFinal` (com desconto), `qualid`, `idioma`, `extras`, `lj_uf`, `idEdicao`, `num`.
Parte dos anúncios **esconde o preço e a quantidade atrás de classes CSS** (`precoCss`, `quantCss`):
o valor só aparece depois que a folha de estilo da página é aplicada. É ofuscação proposital contra
raspagem. Não vale decodificar: o resumo em `cards_editions[].price` já resolve o objetivo.

### `cardsjson` da página de edição

Uma linha por carta da edição: `nEN`, `nPT`, `sN` (número), `p1a`/`p1b`/`p1c` (menor/médio/maior do
normal), `idE`, `id` (id da carta), `iR` (raridade). Não traz foil. O scraper antigo do
`mtgdeck_app` procurava esse mesmo `cardsjson`, mas com campos `sNomeIngles`/`precoMenor`, que não
existem mais. O formato mudou.

## 3. Casamento com o Scryfall (edição certa)

O app identifica a impressão por `scryfallId` + `finish` (é a chave do `prices.json` e das tabelas).
A Liga usa código e número próprios. Regras medidas na Counterspell (87 impressões, o pior caso que
achei, cheio de promo e Secret Lair):

| Passo | Regra | Impressões |
|---|---|---|
| 1 | `code` e `num` iguais aos do Scryfall | 22 |
| 2 | normaliza o código e compara o número | 33 |
| 3 | código normalizado tem uma única impressão daquela carta | 10 |
| | não resolvido | 22 |

Normalização usada:

- prefixos de variante da Liga: `cb` (variantes), `b`/`bl` (borderless), `rf` (retro frame),
  `p` (promo), `jp` (japonês), `sh` (source material), `fs`. Ex.: `cbmh2#308` = `mh2#308`,
  `bl2x2#361` = `2x2#361`, `rfdmr#281` = `dmr#281`.
- Secret Lair: a Liga quebra em um código por drop (`sld382`, `sld268jp`, `sldex08`). Tudo vira `sld`
  e o número bate com o do Scryfall.
- `mfpfYY` vira `pfYY`.
- tabela fixa para códigos antigos: `7e→7ed`, `6e→6ed`, `5e→5ed`, `4e→4ed`, `mm→mmq`, `tp→tmp`,
  `ia→ice`, `rv→3ed`, `un→2ed`, `be→leb`, `al→lea`, `st→s99`, `bd→btd`, `br→brb`, `cedi→cei` etc.
  Nas coleções antigas o número da Liga **não** bate com o do Scryfall (ex.: Era Glacial 62 contra
  ice 64), por isso o passo 3.

Sobram WCD e Pro Tour Decks (a Liga põe todos os anos num código só, `wcd`, com número tipo
`20040927`; o Scryfall separa em `wc97`...`wc04`), Judge/FNM/Media Inserts e Mystery Booster.
Isso fecha com mais linhas na tabela, e a página `?view=cards/edicoes` deve dar o resto.

Casar por data de lançamento (`date` contra `released_at`) eu também testei. Erra em silêncio
(mandou `cedi` para `2ed` e o `#7010` do Bob Esponja para o `#1933`). Descartado como regra principal.

O script `liga_parse.py` nesta pasta faz tudo isso a partir de um HTML ou HAR salvo à mão, sem tocar
na Liga: `python liga_parse.py download --scryfall`.

## 4. O que já existia no `mtgdeck_app`

- `scraper/scrape.mjs` + `set-map.json` (placeholders) + workflow diário: parado desde 2026-08-07.
- `src/ligaPrices.ts`: busca direto do celular, fora do build da loja por violar a política
  "Device and Network Abuse" da Play e os termos da Liga.
- `src/pricing.ts`: consome `prices.json` (`{ "<scryfallId>:<finish>": { brl, brl_avg, usd } }`).
  Esse contrato continua bom. O que este estudo acrescenta: a página da carta **separa foil**
  (era um TODO) e a granularidade é por impressão (`code`+`num`), não por edição.

## 5. Caminhos possíveis

O que não recomendo: qualquer coisa que passe pelo Cloudflare sem uma pessoa na frente (navegador
"stealth", resolvedor de captcha, copiar o cookie `cf_clearance` do Chrome para um servidor). Além de
contornar uma proteção que o site colocou de propósito, quebra a cada mudança do Cloudflare e
coloca a conta do usuário na Liga em risco.

Em ordem de preferência:

**A. Pedir para a Liga.** Ver os Termos de Uso e perguntar se existe API, feed ou parceria
(lojistas têm painel próprio; a RapidAPI "Liga Preços Brasileiros para TCG" citada no README do
scraper também vale checar quem mantém e se é autorizada). É a única via que sustenta o app publicado.

**B. Coleta pelo navegador do próprio usuário.** Uma extensão de Chrome (ou bookmarklet) que, quando
**a pessoa** abre uma página de carta na Liga, lê `cards_editions` e manda os preços para o Grimório
(Supabase do `mtgdeck_web`). Sem robô, sem volume, sem contornar nada: é o mesmo dado que já está
na tela dela. Serve bem para uso pessoal e para "atualizar preço desta carta". Não serve para precificar
uma coleção inteira de uma vez.

**C. Link direto + autocomplete, já.** O web app pode chamar `clubedaliga.com.br/api/cardsearch`
direto do navegador (CORS liberado) para achar o nome certo e abrir
`https://www.ligamagic.com.br/?view=cards/card&card=<nome em inglês>` num botão "Ver na Liga".
Custo zero, nenhuma raspagem.

**D. Referência por câmbio.** `prices.usd`/`usd_foil`/`eur` do Scryfall × câmbio (AwesomeAPI), com
rótulo claro de "estimativa". É o que já estava previsto como plano B.

Uma combinação razoável: C + D agora, B como recurso pessoal, A em paralelo.

## 6. Onde você pode ajudar

1. **Termos de Uso / contato.** Ler os termos da Liga e decidir se vale escrever pedindo acesso.
2. **HAR de `?view=cards/edicoes`** (lista de edições). Com ela fecho a tabela de códigos para todas
   as coleções, não só as da Counterspell.
3. **HAR de duas cartas "difíceis"**, por exemplo uma dupla face (Delver of Secrets) e um terreno
   básico (Forest, centenas de impressões), para validar nome e volume.
4. **Decidir B.** Se quiser a extensão, monto o protótipo lendo `cards_editions` e gravando no
   formato do `prices.json`.

## 7. Cuidado com os arquivos desta pasta

O HAR `download` foi gerado logado: contém id e nick da conta, token dos comentários e telefone de
lojas. Esta pasta está dentro do repositório **público** `mtg-deck-data`. Coloquei `ligamagic/download`
e `*.har` no `.gitignore` da raiz. Novos HARs: salvar como `.har` ou dentro de `ligamagic/capturas/`.

---

# Parte 2 · Cloudflare, endpoints do app e classificação das edições

Data: 2026-11-02 (segunda rodada). Fontes novas: HAR `download2` (Delney, MKM), testes de rota com
`curl` puro e `curl_cffi`, JS do site mobile (`/_mobile_lm/`), lista oficial de edições da Liga e
o rastreamento de tráfego dos apps publicado pelo AppGoblin.

O `download2` também mostrou o formato do link direto para uma impressão:
`?view=cards/card&card=<nome EN>&aux=<nome PT>&ed=<id numérico da edição>&num=<número>`. O `ed` é o
`id` de `cards_editions` (ex.: 480392 = MKM), não o código. Ele define a edição aberta por padrão.

## 8. Como o Cloudflare é acionado

São duas camadas. A resposta bloqueada sempre traz o cabeçalho `cf-mitigated: challenge` e status 403.

**Camada 1 · bot score no site inteiro.** Qualquer cliente que não se pareça com um navegador
(User-Agent, impressão digital TLS e HTTP/2) recebe o desafio em **qualquer** página, inclusive a
home e os `/ajax/`. Testado com `curl` puro: home, decks e o ajax mobile, todos 403. Trocar só o
User-Agent não basta (TLS de Chrome com UA `curl/8` também cai).

**Camada 2 · regra para as páginas de preço.** Mesmo com cara de navegador, estas rotas pedem
desafio interativo a quem não tem o cookie `cf_clearance`:

| Rota (`?view=`) | Resultado |
|---|---|
| `cards/card`, `cards/search`, `cards/lista`, `cards/edicoes`, `cards/emalta`, `cards/pricehistory`, `prod/home` | 403 desafio |
| `home`, `dks/decks`, `dks/deck`, `artigos/home`, `leilao/listar`, `mp/showcase/home`, `logar` | 200 |
| `/ajax/*.php`, `/_mobile_lm/ajax/*.php` | 200 (só passam pela camada 1) |

A Liga protege de propósito as telas de preço e busca de cartas. O `cf_clearance` que o navegador
ganha ao passar no desafio fica preso ao navegador, ao IP e ao User-Agent. O histórico de preço tem
regra mais dura ainda (pediu desafio até ao Chrome logado).

**Resposta direta à pergunta "dá para acessar sem passar pelo Cloudflare?":** de um navegador de
verdade, sim, por endpoints que a camada 2 não cobre (seção 9). De um script ou servidor, não sem
disfarçar o script de navegador, e isso é contornar a detecção de bots do site. Não monto esse
caminho: é o que o Cloudflare deles está configurado para barrar, a Liga pode fechar a brecha a
qualquer momento, e o volume de um servidor vira raspagem contra a vontade declarada do site
(`robots.txt` com `Crawl-delay: 360`).

## 9. Endpoints do site mobile (o que os apps usam)

O site mobile `/_mobile_lm/` é uma SPA em jQuery (`controllers_v117.js`) que busca fragmentos HTML
nestes endpoints, relativos a `https://www.ligamagic.com.br/_mobile_lm/`:

| Endpoint | Parâmetros | Retorno |
|---|---|---|
| `GET ajax/search.php` | `card=<nome>&cardID=&edicaoID=&sNumber=&exactMatch=1&page=1&category=1&tcg=1` | HTML da carta: **lista de edições com menor/médio/maior** (só normal, sem foil, sem número) e as primeiras ofertas. Cada edição traz o código em `appScreen.editionSearch('mh2')`. |
| `GET ajax/cards/precoedicoes.php` | `cardID=<id>` | Preço por edição. Respondeu 500 sem sessão. |
| `POST ajax/cards.php` | `opc=getHistorico&id=&IDEdicao=&sNumber=&tcg=1` | Histórico. 403 "não foi possível validar a origem do formulário" (exige token da página). |
| `POST ajax/cards/home.php` | `format, period, group, page, tcg` | Cards em alta. |
| `POST /ajax/cards/getEditionsByTCG.php` | `tcg=1` | **XML com as 1612 edições** (código e nome PT/EN). |

Esses endpoints não mandam cabeçalho CORS: o web app do Grimório **não consegue** chamá-los direto do
navegador. Uma extensão de Chrome com permissão para `ligamagic.com.br` consegue.

Perto da página desktop, o `ajax/search.php` é mais pobre: não separa foil, não traz número de
coleção e soma as impressões de um mesmo código (o Secret Lair aparece agregado).

## 10. Os aplicativos

| App | Pacote | O que é |
|---|---|---|
| LigaMagic | `br.com.ligamagic` | Preços e compra (desde 2017, ~72 mil instalações). Sem análise de tráfego publicada. |
| LigaPkm | `br.com.ligapokemon` | Mesmo produto para Pokémon, com scanner. |
| Circuito LigaMagic | `br.com.circuitoligamagic` | Torneios, sem preço. |

O AppGoblin registrou o tráfego do LigaPkm: ele só fala com `www.ligamagic.com.br/_mobile_lm/`,
`challenges.cloudflare.com/turnstile` e `cdn-cgi/challenge-platform`, além do Firebase. O app é um
**WebView do site mobile** e passa pelo mesmo Cloudflare, Turnstile incluído. Não há API separada
"sem verificação humana" por trás dele: o app só passa na camada 1 porque roda um navegador embutido.
Pelo mesmo desenvolvedor e pela mesma estrutura, o app LigaMagic deve ser igual (não confirmado).

Emular um celular: dá (o Android SDK com `emulator` já está instalado aqui), mas a evidência indica
que não vai aparecer nada além da seção 9. Para confirmar: AVD com imagem "Google Play", você entra
com sua conta e instala pela Play Store, e o WebView é inspecionado pelo `chrome://inspect` do PC.
Não baixo APK de site espelho (fonte não confiável).

## 11. Por que a Liga classifica edições de outro jeito

A Liga tem **1612 edições** de Magic; o Scryfall tem 1066 sets. Três escolhas explicam:

1. **Uma "edição" por tratamento visual.** A Liga é marketplace: a loja cadastra estoque por edição,
   e Borderless, Extended Art, Showcase ou Surge Foil têm preço diferente da versão comum. Em vez de
   deixar isso no número de coleção, como o Scryfall, ela cria uma edição filha (`exmom` = March of
   the Machines (Extended Art), `jsdsk` = Duskmourn (Japan Showcase), `iimkm` = MKM (Invisible Ink),
   `dsmkm` = MKM (Dossier), `cbmh2` = MH2 (Variants)). Sufixos mais comuns: Extended Art (47),
   Borderless (41), Tokens (40), Art Series (39), Promo (34), Variants (25), Headliner, Foil Etched,
   Surge Foil, Serialized, Japan Showcase, Retro Frame.
2. **Secret Lair por drop.** 457 edições `sldNNN`. O Scryfall põe tudo em `sld`; o número bate.
3. **Códigos herdados.** As coleções antigas usam siglas da época: `al`, `be`, `un`, `rv`, `ia`,
   `tp`, `mm`, `ne`, `in`, `ds`, `mt`, `lw`. O Scryfall usa os códigos oficiais de 3 letras (`lea`,
   `leb`, `2ed`, `3ed`, `ice`, `tmp`, `mmq`...). Nessas coleções o número de coleção também diverge.

Foil e foil etched comuns não viram edição: ficam nas chaves de `price` (`dataExtras`). Os foils
especiais (Surge, Textured, Galaxy, Raised) viram edição própria.

### Mapa pronto

`liga-set-map.json` (nesta pasta) leva cada uma das 1612 edições a um set do Scryfall:

| Regra | Edições |
|---|---|
| nome base + tratamento ("Kaldheim (Art Series)" → `khm`) | 490 |
| Secret Lair → `sld` | 457 |
| código igual | 398 |
| nome inglês igual | 103 |
| tabela manual (códigos antigos) | 31 |
| prefixo no código | 26 |
| **sem regra** | **107 (6,6%)** |

As 107 restantes são promos e produtos raros (Guild Kits, Mythic Edition, SDCC, Arena League, Media
Inserts, WCD). Dentro do set, o número de coleção desempata. Ajuste pendente: a regra "nome base"
manda Art Series e Tokens para o set principal, e no Scryfall eles moram em sets próprios (`akhm`, `tkhm`).

## 12. Recomendação revisada

- **Servidor raspando a Liga:** continua fora. Nenhuma rota é alcançável por script sem fingir ser navegador.
- **Extensão de Chrome (melhor caminho prático):** roda no navegador do usuário e passa no Cloudflare
  como qualquer visita. Pode usar o `/_mobile_lm/ajax/search.php` (uma chamada por carta) ou ler
  `cards_editions` quando a pessoa abre a página da carta (mais completo, tem foil e número). Com
  intervalo generoso e só as cartas da coleção, o volume fica parecido com o de uma pessoa navegando.
  Continua sendo uso que a Liga não previu: tratar como recurso pessoal.
- **App publicado na Play:** preço por câmbio do Scryfall, botão "Ver na Liga" com o link direto
  (`ed=<id>&num=<n>`) e o pedido formal de acesso à Liga.

> Atualização (2026-11-02): a estimativa por câmbio do Scryfall foi descartada pelo usuário. Ver Parte 3.

---

# Parte 3 · Como os projetos do GitHub buscam preço na Liga

Levantamento feito em 2026-11-02 com `gh search repos ligamagic` e `gh search code ligamagic.com.br`.

## 13. Os métodos encontrados

| Projeto | Data | Como busca | Situação hoje |
|---|---|---|---|
| RodrigoMRoli/GetPriceLigamagic (PHP) | 2022 | `file_get_contents` em `cards/search&card=ed=<sigla>` e lê `var cardsjson` (campos antigos `sNomeIngles`, `precoMenor`) | Quebrado: Cloudflare dá 403 e os campos mudaram |
| undeca11/staples10 (Python) | 2026 | `requests` + BeautifulSoup na página do deck (`pdeck_preco_2`) | Depende do IP; do nosso teste, requisição simples toma 403 |
| marvynmesquita/oraculo-de-tassa (Next.js) | 2026 | Esqueleto comentado com `fetch` + cheerio; hoje só gera link para a Liga | Nunca funcionou |
| lunarafael/LigaMagicScrapper, rplemos/ligamagic_collection, KleytonFSantos/card-spike-bot (Python) | 2025/2026 | Playwright headless com User-Agent trocado. O rplemos tem uma função só para diagnosticar a tela "Um momento…" | Instável; o card-spike-bot sobe screenshot de depuração no GitHub Actions |
| kammradt/ligamagic-scrapper (Ruby), fredrbo/Ligamagic-Price-Tracker | 2025 | Selenium/Capybara com Chrome | Mesmo problema do Playwright |
| Pedrogush/ligamagic_ocr_scraper | 2024 | `curl_cffi` com `impersonate='chrome'` e OCR (Tesseract) nos sprites de número do `cards_stock` | Contorno de detecção; não usar |
| gustavocs/precos-ligamagic | 2026 | Extensão de Chrome: `fetch` com cookies do usuário e, se cair no desafio, abre a carta numa aba em segundo plano e lê o JSON de edições | Funciona, mas é extensão |

Nenhum projeto tem um endpoint "secreto" de API. Todos leem as mesmas variáveis JS da página
(`cardsjson`, `cards_editions`) ou o HTML. A diferença está só em quem faz a requisição: um servidor
(bloqueado), um navegador automatizado (instável e é contorno), ou o navegador real do usuário
(funciona).

## 14. Caminho para o app (sem extensão)

O equivalente da extensão dentro do app Expo é uma `react-native-webview` no aparelho do usuário:
o app abre a página da carta na Liga dentro de uma WebView, o próprio WebView do Android resolve o
Cloudflare como qualquer navegador (se aparecer o desafio, a pessoa vê e responde), e o app lê
`cards_editions` com `injectedJavaScript` e `postMessage`. É o mesmo modelo do app oficial da Liga,
que também é uma WebView. Os preços lidos vão para um cache compartilhado (Supabase), que o
`mtgdeck_web` e os outros usuários leem sem ir à Liga.

Pontos em aberto: política da Play ("Device and Network Abuse") e os termos de uso da Liga.

## 15. Página de coleção (captura `babalysaga`, 2026-11-02)

- URL: `?view=colecao/colecao&id=<idColecao>&orderBy=7&modoExibicao=2&page=N` (80 itens por página).
  Os parâmetros `pgA..pgH` levam totais já calculados (pgA itens distintos, pgB cópias, pgC/pgD/pgE
  soma menor/médio/maior).
- Cada item é um bloco `div#cc_card_<idCard>_<idEdicao>` com o preço da edição no HTML puro, sem a
  ofuscação de CSS do `cards_stock`: `col-prices` traz menor / médio / maior.
- `moveCard.init(idCardColecao, idCard, idEdicao, "sNumber", iIdioma, iQualid, iExtras, iQuant, idColecao)`
  traz o número de coleção e o extra de cada item. Na captura todos os itens têm extras 0.
- O link de cada item usa o código da edição (`card=<EN>&ed=<sigla>`), que casa com o `liga-set-map.json`.
- Telas de cadastro: `colecao/cad_simples`, `cad_lista` (colar lista), `cad_massa` (edição inteira,
  `ajax/colecao/colecao_buscaMassa.php`), `import`, `import_bzr`, `export`, `analise`.
- A captura só tem o carregamento final da coleção; o envio da lista (POST do cadastro) não foi gravado.

## 16. Fluxo completo de cadastro por lista ("Lista Teste 01", id 631424, 2026-11-03)

Capturado passo a passo com o chrome-devtools-mcp; corpos em `capturas/` (fora do git). A tabela
linha a linha está em `capturas/analise_lista_teste_01.txt`.

| Passo | Requisição | O que faz |
|---|---|---|
| 1 | `GET ?view=colecao/config` | Formulário "Criar Coleção" (nome, privacidade 1 privada / 2 pública / 3 compartilhada, capa) |
| 2 | `POST ?view=colecao/config` (multipart) | Campos `colecao_nome`, `privacidade_tipo`, `capa_tipo`, `VALID_SEC_UNIQUE_TOKEN` (token CSRF da página). Responde 302 para `cad_opcoes&id=<nova>` |
| 3 | `GET ?view=colecao/cad_opcoes&id=N` | Menu: Cadastro Simples, por Lista, em Massa, Exportar, Importar |
| 4 | `GET ?view=colecao/cad_lista&id=N` | Textarea (até 150 linhas) + botão "Checar Lista" |
| 5 | `POST /ajax/cards/getCardsCheck.php` | `windowWidth`, `cards` (a lista crua), `tooltip=1`, `iTCG=1`. Responde JSON `{html, images}` com uma linha por carta: id Liga da carta, número, e um `<select>` com **todas** as edições daquela carta, já com a edição da lista marcada quando reconhece a sigla. Não traz preço. Erros voltam como texto `<!-- !ERRO -->` (ex.: "Card não encontrado", "Informar quantidade") |
| 6 | `POST ?view=colecao/cad_lista&id=N` (form) | Por linha: `c_lote_cad_quant[i]`, `c_lote_cad_ide_card[i]`, `c_lote_cad_snumber[i]`, `c_lote_cad_idioma[i]`, `c_lote_cad_qualidade[i]`, `c_lote_cad_edicao_i[]`, `c_lote_cad_extras_i[]`, mais `card_list` (texto original) e os espelhos `ITEM_*_TEM` separados por `;;;`. Responde "Foram adicionados 112 cards" |
| 7 | `GET ?view=colecao/colecao&id=N[&page=2...]` | A coleção com preço menor/médio/maior de cada item, 80 por página, e totais `pgC/pgD/pgE` (normal) e `pgF/pgG/pgH` (foil) |

Durante o POST do passo 6 o Cloudflare rodou o script invisível `cdn-cgi/challenge-platform/.../jsd/oneshot`
e renovou o `cf_clearance`. Não apareceu Turnstile em nenhum passo.

### O que o teste mostrou

- **Resolução de edição:** das 93 linhas, 75 tiveram a edição marcada automaticamente a partir da sigla do
  Scryfall (CLB, MH2, M3C, DSC, PLIST com número...). Ficaram sem edição: `PLST` sem número (8),
  siglas antigas que a Liga escreve diferente (MRD, LRW, 5ED, TMP, WTH, RVR, BRR, HA7) e os básicos
  (Forest ELD, Swamp UND). Para essas escolhi a primeira opção da lista, como combinado.
- **Número de coleção:** a Liga guarda o número da lista quando ele existe na edição dela. Quando não
  existe, troca pelo número da impressão comum: Mirkwood Bats LTR 421 virou ltr/95, Ornithopter DMR 386
  virou dmr/233, Peregrin Took LTR 807 virou ltr/181. Ou seja, variantes (borderless, showcase) que a Liga
  separa em outra edição caem na edição principal e levam o preço da versão comum.
- **Preço:** a coleção só mostra o preço do extra cadastrado (todos normais aqui). Foil precisa ser
  cadastrado como foil (`*F*` na lista ou o select de extras).
- **Sem API de preço em lote:** o preço não vem de nenhum ajax; é calculado no servidor e impresso no HTML
  da página da coleção. O ajax `getCardsCheck` só resolve nomes e edições.

## 17. O app oficial `br.com.ligamagic` por dentro (2026-11-03)

Instalado pela Play Store num emulador (AVD "Medium - API 34", Android 14 com Play Store); versão
2026.04.2416, targetSdk 36. O APK instalado foi copiado com `adb pull` e lido sem executar nada.

- É uma casca de WebView: uma única `MainActivity` que abre `https://www.ligamagic.com.br/_mobile_lm/?tcg=1`.
  O único JavaScript injetado esconde o banner "baixe o app" (`#android-app`) e trata o botão voltar
  (`hist.back()`). O resto é Firebase (push, analytics, crashlytics) e anúncios.
- Não há API própria, chave, token ou endpoint escondido. O app usa os mesmos `ajax/*.php` do site
  mobile (seção 9). Ao abrir uma carta, o SPA chama `ajax/search.php?cardID=&edicaoID=&sNumber=...`
  (lojas e edições principais) e "Ver mais edições" chama `ajax/cards/precoedicoes.php?cardID=`
  (todas as edições com menor/médio/maior, só preço normal). Esse último dava 500 fora do WebView
  porque depende da sessão criada ao abrir o `_mobile_lm`.
- O WebView não é depurável (sem socket `devtools_remote`), então o `chrome://inspect` não enxerga a página.
- Sem login e sem Turnstile visível: o WebView é um Chromium de verdade no IP da pessoa, e o Cloudflare
  deixa passar como deixa um navegador comum.

Conclusão: o app da Liga confirma o caminho do WebView no Grimório. Ele faz exatamente o que o
Grimório faria: abrir o `_mobile_lm` num WebView e consumir as mesmas páginas.

## 18. Preços pelo app e inspeção do WebView (2026-11-03)

### Busca de 69 cartas pelo app
- Feita no emulador com Play Store, dirigindo a interface do app oficial por `adb` (tocar na lupa,
  digitar o nome sem acento, escolher a sugestão, abrir "Ver mais edições") e lendo a tela pela árvore
  de acessibilidade (`uiautomator dump`), que expõe o texto do WebView. Script:
  `scratchpad/tools/app_precos.py`. Resultado: `precos-liga-app.csv` (resumo) e
  `capturas/precos_app.json` (todas as edições lidas de cada carta).
- 69 de 69 cartas resolvidas, sem nenhum desafio do Cloudflare. Levou cerca de 1 hora porque cada
  passo da interface espera a tela; não é limitação da Liga.
- Tropeços: o primeiro dump depois de abrir o app vem vazio (o WebView só monta a árvore de
  acessibilidade na segunda chamada); apóstrofo não passa no `adb input text` (digitamos até o apóstrofo).

### Inspecionar o WebView do app
- No emulador com Play Store (build `user`) o WebView não é depurável.
- Solução: imagem oficial "Google APIs" do Android 14 (`system-images;android-34;google_apis;x86_64`,
  build `userdebug`, `ro.debuggable=1`). Nela todo WebView abre o socket `webview_devtools_remote_<pid>`.
  AVD `Liga_Debug_API34`; o mesmo APK baixado pela Play foi instalado com `adb install-multiple`.
- `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` expõe o CDP; `chrome://inspect`
  também passa a listar a página. A gravação de rede foi feita com CDP puro (`websocket-client`,
  `Network.enable` + `Network.getResponseBody`), script `scratchpad/tools/cdp_rede.py`; o Playwright
  `connect_over_cdp` não funciona com o alvo "browser" do WebView.

### O que a rede do app mostrou
1. Autocomplete: `GET https://ac.ligamagic.com.br/api/cardsearch?tcg=1&maxQuantity=8&categ=1&query=<texto>`
   (JSON com `sNomeIdiomaPrincipal`, `sNomeIdiomaSecundario` e `__key` `marketplace:cards:tcg1:<idCarta>_1`).
   Mesmo serviço do `clubedaliga.com.br/api/cardsearch` (seção 9), em outro host.
2. Carta: `GET /_mobile_lm/ajax/search.php?card=<nome EN>&cardID=0&edicaoID=0&sNumber=&exactMatch=1&orderBy=1&page=1&category=1&tcg=1`
   devolve um HTML (~100 KB para o Sol Ring) com **todas** as edições já carregadas (menor/médio/maior,
   código da edição em `appScreen.editionSearch('<sigla>')`) e a primeira página de lojas.
   "Ver mais edições" só mostra linhas que já vieram escondidas; não faz nova requisição.
3. `ajax/cards/precoedicoes.php?cardID=` responde 500 até dentro do app; é código antigo sem uso.
- Os preços dessa tela são só do normal. Foil e número de coleção continuam só na página desktop.

### Busca só por endpoints, dentro do WebView (2026-11-03)
- Script `scratchpad/tools/cdp_lote.py`: via CDP, roda um `fetch` no contexto da página `_mobile_lm`
  do app (mesma origem, mesma sessão) para cada carta: `ac.ligamagic.com.br/api/cardsearch` (nome em
  inglês) e `_mobile_lm/ajax/search.php` (todas as edições), e lê o HTML com `DOMParser`
  (`div.clearfix[onclick*="editionSearch"]`, preços em `.card-results-price`). Nomes do autocomplete
  vêm com entidades HTML (`&ecirc;`) e precisam ser decodificados.
- Mesma lista de 69 cartas: 122 s com pausa de 1,5 s entre cartas (contra ~1 h tocando na tela).
  68 de 69 menores preços idênticos à busca pela interface; a diferença (The Earth King 4,94 → 5,00)
  é o mercado mudando entre as duas rodadas. Saída: `precos-liga-endpoint.csv`.
- Fora do WebView, `search.php` continua 403. O autocomplete `ac.ligamagic.com.br` respondeu a um
  curl simples, mas não traz preço.

## 19. Preço por edição e preço de deck em lote (2026-11-03)

- **Lote numa chamada só:** `scratchpad/tools/deck_precos.py` manda a lista inteira de nomes (em
  inglês) para o WebView num único `Runtime.evaluate`; dentro da página um laço chama `search.php` por
  nome com 1,5 s de pausa e devolve tudo junto. Deck de 93 linhas: 162 s.
- **Edição específica sem requisição extra:** o `search.php` já traz todas as edições da carta com a
  sigla da Liga (`editionSearch('<sigla>')`). A sigla certa sai do `(SET) número` da lista:
  Scryfall `/cards/collection` dá set e tratamento (borderless, extended art, showcase, retro, etched,
  serialized, surge foil) e o `liga-set-map.json` converte set+tratamento em sigla da Liga.
- **Página desktop no WebView:** `fetch('/?view=cards/card&card=...')` dentro do app dá 403
  `cf-mitigated: challenge` ("Just a moment..."). Foil continua fora de alcance pelo app.
- **Deck `baba-lysaga-teste.txt`:** menor preço de qualquer edição R$ 530,61; menor preço da edição da
  lista R$ 621,30. Das 93 linhas: 80 na edição principal, 4 em tratamento especial (Borderless Scene,
  Retro Frame, Borderless), 9 sem a edição da lista na Liga (7 cartas de The List que a Liga não tem
  nesse set, Forest ELD, Swamp UND, Springleaf Drum BRR, Unearth HA7). Saída `precos-deck-baba-lysaga.csv`.
- **Lacunas do mapa:** alguns tratamentos não têm sigla no `liga-set-map.json` (ex.: Showcase Ring do
  LTR, Retro Frame do BRC, BRR e HA7), e nesses casos cai na edição principal ou fica sem preço; o CSV
  diz em cada linha como a edição foi escolhida.

## 20. Variações de busca aceitas e o problema do foil (2026-11-03)

Testado com `fetch` dentro do WebView do app (`scratchpad/tools/t_var.js`, `t_raw.js`).

### `_mobile_lm/ajax/search.php`
Parâmetros: `card`, `cardID`, `edicaoID`, `sNumber`, `cardAux`, `exactMatch` (0/1), `orderBy`, `page`,
`category` (1 cards, 2 artigos, 3 produtos, 4 decks), `tcg=1`.

| Variação | Resultado |
|---|---|
| `card=Sol Ring&exactMatch=1` (inglês) | página da carta, 116 edições |
| `card=Anel Solar&exactMatch=1` (português) | a mesma página, 116 edições |
| `card=Contramagica` e `card=Contramágica` | iguais: acento é ignorado |
| `cardID=16117&card=` | a mesma página (id da Liga, vem do autocomplete `__key`) |
| `card=sol rin&exactMatch=0` | lista de até 25 resultados (`appScreen.cardOpen(id,0,'')`), sem preços |
| `card=Sol Ring foil=1` / `card=Sol Ring ed=m3c` com `exactMatch=1` | os filtros são ignorados quando o nome casa: mesma página, preços normais |

Filtros de texto da busca avançada do SPA (`advsearch.getParams`), concatenados no `card` com espaço:
`ed=<sigla>`, `rarid=`, `cor=`, `formato=`, `foil=1`, `alterada=1`, `assinada=1`, `buscarem=1|90`,
`categ=`, `loja=<nome>`. No `exactMatch=0` eles filtram a lista de resultados, que não traz preço.

Autocomplete `ac.ligamagic.com.br/api/cardsearch`: aceita português, inglês, com ou sem acento;
devolve `sNomeIdiomaPrincipal` (PT, com entidades HTML), `sNomeIdiomaSecundario` (EN) e o id.

### Foil
- O resumo de edições do `search.php` é sempre o preço normal; não há variação que devolva foil.
- As ofertas das lojas no mesmo HTML têm o preço ofuscado por sprite de CSS (anti-raspagem): fora de uso.
- O foil só aparece na página desktop da carta (`cards_editions[].price["2"]` foil, `["31"]` etched).
  Dentro do WebView, `fetch` nela dá 403; navegar até ela mostra o Turnstile. Primeiro roda sozinho
  ("Verifying..."), depois pede a caixa "Verify you are human" (no emulador de depuração, com DevTools
  conectado). Quem marca a caixa é a pessoa; o app não pode marcar por ela.
- Caminhos para foil: (a) a pessoa passa pelo desafio uma vez no WebView e o `cf_clearance` fica no
  cookie do WebView, liberando as páginas desktop por um tempo; (b) coleção na conta da pessoa com o
  extra Foil (a página de coleção mostra o preço do extra cadastrado, seção 15/16).

## 21. Foil resolvido pela página completa da carta (teste de 03/11/2026)

- No emulador de depuração, o WebView do app oficial foi levado a `https://www.ligamagic.com.br/?view=cards/card&card=Counterspell`. A Cloudflare mostrou a verificação "Verify you are human", que o usuário marcou à mão.
- Depois disso, `fetch('/?view=cards/card&card=<nome>')` feito de dentro do próprio WebView passou a voltar 200, sem `cf-mitigated`. Foram 6 cartas em 12 s, com pausa de 1,5 s (Counterspell, Sol Ring, Peregrin Took, Lightning Bolt, Arcane Signet, Command Tower).
- O preço vem no script da página, em `cards_editions = [...]`, com uma entrada por impressão:
  - campos: `code` (sigla da Liga em minúsculas, por exemplo `rsltr`), `num` (número de colecionador), `idcard`, `name` (edição), `rarid`, `date` e `price`;
  - `price` como lista `[{p,m,g}]`: a impressão só tem preço normal;
  - `price` como objeto: as chaves são extras, `"0"` normal, `"2"` foil e `"31"` foil etched. Também aparecem `3`, `13`, `17`, `29`, `37` e `41` (outros extras, ainda sem rótulo confirmado);
  - `p`, `m` e `g` são menor, médio e maior. Uma chave com `[]` quer dizer que não há oferta;
  - exemplo: Peregrin Took `rsltr` 807 tem normal 12,99/20,23/39,90 e foil 12,99/20,23/39,90; `srltr` 315 tem normal a partir de 1,50 e foil a partir de 4,99.
- Ganho extra: o número de colecionador (`num`) vem por impressão, o que resolve a escolha da edição exata sem depender só do liga-set-map.
- Limite: a liberação vale para aquele WebView, aquele aparelho e aquela rede, e expira. Não se copia nem se automatiza a verificação: quando ela expirar, o próprio usuário passa de novo, dentro do app.
- Fluxo sugerido para o Grimório: usar `_mobile_lm/ajax/search.php` (sem verificação) para o preço normal, e só para cartas marcadas `*F*` abrir a página completa no WebView. Se aparecer a verificação, mostrar o WebView ao usuário.
- Amostra salva em `var/t_foil.json` (scratchpad da sessão).
