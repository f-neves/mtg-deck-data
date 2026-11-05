# Estudo: como o app LigaPkm reconhece a edição da carta pela câmera

Teste feito em 03/11/2026 no emulador `Medium_-_API_34`. O app `br.com.ligapokemon` v2026.06.1620 foi instalado pela Play Store e os APKs foram copiados do aparelho para análise estática. O dataset de cartas do app vem criptografado e não foi aberto: o estudo usa só os nomes de arquivos, os textos do binário e as telas do app.

## 1. O que tem dentro do app

- O app é feito em Flutter (`libapp.so` e `libflutter.so`), com câmera CameraX (`camera_android_camerax`). Diferente do app da LigaMagic, não é só um WebView.
- Bibliotecas de visão:
  - `google_mlkit_text_recognizer` faz o OCR (ML Kit, script latino);
  - `libnative_opencv.so` (37 MB) faz o recorte e a normalização da imagem (textos `filtersCrop`, `filtersNormalization`);
  - `assets/model_tf/card_classifier_v2.tflite` (4 MB), com `labels.txt` = `card`, `not_card`. É só um portão: decide se há uma carta no quadro antes de gastar OCR. Ele não identifica qual carta é.
- Configuração em `assets/flutter_assets/.env`:
  - `TENSOR_FLOW_DETECTION=true`: liga o classificador;
  - `REMOTE_ENCRYPTED_CARD_DATASET_URL_TEMPLATE=https://repositorio.sbrauble.com/arquivos/txt/appligapokemon_encrypted_{date}.zip`: base de cartas baixada por data;
  - `ENCRYPTED_CARD_SNAPSHOT_KEY`: chave do dataset (não usada aqui);
  - `TELEMETRY_SHEETS_URL`: telemetria do scanner enviada a uma planilha Google (Apps Script).
- Testes de integração embutidos (`integration_test/assets/*.yuv`): 14 cartas reais, 3 quadros de câmera cada (por exemplo `druddigon1..3.yuv`, `maos-ferreos-ex1..3.yuv`). São fotos de carta em português sobre a mesa, sem recorte. Ou seja, eles testam o pipeline com quadros crus gravados da câmera.

## 2. O pipeline (reconstituído pelos textos do binário)

1. **Base local.** Ao abrir o scanner aparece "Carregando dados...": o app baixa o zip do dia, descriptografa e guarda num banco local Hive (`encryptedCardDatasetBox`, `encryptedCardDatasetFileDate`). O casamento acontece no aparelho, sem chamar servidor por carta.
2. **Portão de carta.** Cada quadro passa pelo classificador TFLite (`detectionMinConfidence`, `detectionMaxConfidence`). Há também um limiar de movimento: "Movimento significativo detectado, resetando threshold" e "Diminuindo sensibilidade do threshold". O app só lê quando a imagem para.
3. **Recorte.** O OpenCV recorta e normaliza duas faixas da carta, e o OCR roda separado em cada uma: "Cabecalho OCR bruto" (nome) e "Rodape OCR bruto" (numeração).
4. **Numeração como chave.** Do rodapé sai a "sequência" no formato `118/159`. Ela passa por um regex e é validada ("Sequência inválida").
5. **Votação entre quadros.** O app junta vários quadros: "Sequencias extraidas", "Candidatos de sequencia", "Most frequent sequence", "Sequencia consolidada". Vale a leitura que mais se repete, não a de um quadro só.
6. **Casamento.** Junta "Nomes normalizados" (do cabeçalho) e a sequência consolidada, busca na base local e devolve `matchCardId`, `matchScore` e `matchStatus`. Os resultados são `SingleCandidate`, `AllCandidates` ou `ambiguous`, e `MatchFailureReason` diz o motivo da falha.
7. **Ambíguo vira escolha.** Com mais de um candidato, a tela mostra `NextCandidate`/`PreviousCandidate` para o usuário passar entre eles.
8. **Correção manual.** Há o campo "Digite a numeração" (`manual-search-sequence-field`) e os avisos "Toque aqui para mudar/manter a leitura da numeração".
9. **Telemetria.** Por leitura, o app registra `ocrConfidence`, `ocrHeaderText`, `ocrRawText`, `matchScore`, `recognitionAttempts`, `successfulRecognitions` e `avgRecognitionTimeMs`, e manda tudo para a planilha. É assim que eles calibram o Beta.

## 3. O que se vê na tela

- A moldura do scanner tem duas caixinhas `/` no rodapé: uma à esquerda e outra à direita. Tocar na da esquerda mostra "Reconhecimento de cartas com numeração a esquerda ativado!". O usuário diz onde fica a numeração e o app escolhe a região do OCR.
- Na ajuda do app, a resposta para "Quais cartas eu posso escanear?" diz que o scan reconhece cartas com numeração no canto inferior esquerdo, em português ou inglês.
- O teste com carta real não foi feito: a câmera do emulador mostra só a sala virtual. Para isso é preciso um celular com o app ou uma webcam ligada ao emulador.

**Resumo do método:** a edição não sai da arte nem de rede neural. Ela sai do número de colecionador impresso na carta, lido por OCR numa região recortada, votado entre vários quadros e casado contra uma base local de (nome, numeração) → carta. A rede neural só diz se há carta no quadro.

## 4. Como está o Grimório hoje (`mtgdeck_app`)

- O OCR é do ML Kit, pelo `react-native-vision-camera-ocr-plus` (ao vivo) e por foto. Há um índice local de nomes, baixado da release `card-index` deste repositório, com resolução de nome local e reserva online (`recognition/nameResolve.ts`).
- O app já tenta a edição: `extractEdition()` em `recognition/cardText.ts` procura `SET •` e `123/350` ou `210 R` no texto inteiro. Depois `fetchCardBySetNumber()` consulta o Scryfall online (`LiveScanScreen.tsx:555`, `ScannerScreen.tsx:184`).
- Pontos fracos em relação ao LigaPkm:
  1. lê o texto da carta inteira num quadro só. A linha do rodapé de Magic é minúscula e quase sempre sai errada nessa resolução;
  2. não há votação entre quadros para set e número;
  3. exige o código do set com o bullet junto, então qualquer erro no `•` derruba a edição inteira;
  4. a confirmação da impressão é online (Scryfall), uma carta por vez;
  5. a arte (`artRecognition.ts`) ainda é um stub.

## 5. O que dá para aplicar no Magic

**A. Região própria para o rodapé (o maior ganho).** Em cartas de Magic de M15 (2014) em diante, o canto inferior esquerdo tem duas linhas:

```
0123/280 R          (ou "0123 R" nas coleções a partir de 2023, sem o total)
NEO • PT  Ilustrador
```

Basta recortar essa faixa (cerca de 6% da altura, no rodapé esquerdo, dentro da moldura que o scanner já desenha), ampliar 2 a 3 vezes e passar o OCR só nela. A lib atual já aceita foto; o recorte pode ser feito na foto capturada (`ImageManipulator`) antes do `recognizePhoto`.

**B. Votar entre quadros.** Guardar as leituras (set, número) dos últimos 5 a 8 quadros e só aceitar quando a mesma dupla aparecer 3 vezes. É o "Most frequent sequence" deles. Isso corta a maior parte dos erros de OCR (0/O, 1/I, 5/S, 8/B).

**C. Base local de impressões.** O LigaPkm casa contra o dataset baixado, e nós já temos o mesmo esquema de release no `mtg-deck-data`. Um segundo arquivo `printings.ndjson.gz`, gerado do bulk `default_cards` do Scryfall, teria:
- os campos `set`, `collector_number`, `lang`, nome EN e PT, `finishes`, `frame_effects`, `border_color` e `promo_types`;
- tamanho de alguns MB.

Com ele o casamento sai sem rede e permite correção: se o OCR lê `NE0` e o número 123, a busca aceita os sets a uma letra de distância que tenham o número 123 e cujo nome bata com o cabeçalho.

**D. Nome e número se confirmam.** Usar o nome (que já reconhecemos bem) para filtrar as impressões, e o número para escolher entre elas. Se a carta tem 40 impressões e o OCR leu só "123", quase sempre sobra uma. É o mesmo que o `matchScore` deles faz com nome e sequência.

**E. Foil pela linha do set.** No Magic moderno, o separador entre set e idioma é `•` na carta normal e `★` na foil (por exemplo, `NEO ★ EN`). O OCR desse caractere na faixa recortada dá a dica de foil, e os preços foil da Liga (seção 21 do ESTUDO-LIGAMAGIC.md) ficam ligados à carta escaneada. O usuário confirma: o `★` é pequeno e pode falhar.

**F. Ambíguo vira lista curta.** Quando sobrar mais de uma impressão (arte alternativa com o mesmo número em promos, cartas antigas), mostrar as imagens dos candidatos para o usuário tocar. Hoje o fluxo cai no seletor de edição completo.

**G. Cartas sem numeração (antes de 2014).** O LigaPkm simplesmente não aceita essas cartas. No Magic há duas opções:
- comparar a arte com as imagens do Scryfall (hash perceptual da área da arte, calculado só entre as impressões daquele nome, que são poucas). Isso preenche o `recognizeByArt`;
- deixar o usuário escolher na lista de edições do nome.

**H. Portão de carta e estabilidade.** Um classificador "tem carta / não tem" e o limiar de movimento economizam bateria e evitam leituras de quadros borrados. É útil, mas vem depois de A a D.

**I. Medir.** Registrar o que o OCR leu, o que casou e o que o usuário corrigiu numa tabela do Supabase (no lugar da planilha deles). Também vale gravar 3 quadros de 20 a 30 cartas reais (normais, foil, borderless, antigas) como teste automático, do mesmo jeito que o LigaPkm faz com os `.yuv`.

## 6. Ordem sugerida

1. A + B + D: recorte do rodapé, votação e casamento com o nome. Usa só o que já existe (OCR e Scryfall online) e já deve resolver a maioria das cartas de 2014 em diante.
2. C: índice local de impressões na release do `mtg-deck-data`, para tirar a rede do caminho.
3. E + F: foil por `★` e escolha entre poucos candidatos.
4. G: arte para cartas antigas.
5. H + I: portão, telemetria e quadros de teste.

## 7. Como o LigaPkm evita ler a mesma carta de novo

Também reconstituído pelos textos do binário. Não deu para testar com carta real no emulador.

- A unidade de leitura é a **presença física da carta no quadro**, não o nome lido. O app usa o detector de objetos do ML Kit (`google_mlkit_object_detector`, com `trackingId` e `objectBoundingBox`) junto do classificador `card`/`not_card`, e acompanha a caixa da carta quadro a quadro.
- `BoundingBoxMovementAnalyzer` compara a caixa entre quadros ("Position change detected. deltaX=", "Scale change detected. deltaWidth=") e marca a leitura como `stable` ou `unstable`.
- Enquanto a caixa estiver lá, é a mesma sessão de reconhecimento. Os quadros só reforçam a votação, e uma leitura repetida conta como duplicata (a telemetria tem `duplicatesRecognitions` e `duplicatesSessions`). Não gera outra carta.
- Quando a caixa some, o app reinicia o reconhecimento ("CameraService: Bounding box ausente, resetando reconhecimento."). A próxima carta que entrar é uma sessão nova, mesmo sendo outro Pikachu da mesma edição. "Result discarded due to session change" descarta resultado atrasado da sessão anterior.
- Movimento grande sem a carta sair também reinicia o limiar ("Movimento significativo detectado, resetando threshold"). Se o usuário trocar a carta rápido por cima da outra, a mudança de posição ou de escala da caixa denuncia a troca.
- Resumo: duas cópias iguais se distinguem pelo "sumiu e voltou" da caixa da carta, não pelo conteúdo. Cartas iguais têm conteúdo idêntico; só a presença física separa uma da outra.

### Comparação com o Grimório (`LiveScanScreen.tsx`)

- Hoje a trava é pelo **nome**: `lastAddKeyRef` guarda a última carta cadastrada, e uma carta não-básica com o mesmo nome em seguida é recusada ("mesma carta seguida"). Terrenos básicos são liberados depois de `BASIC_REPEAT_MS` (3 s). Isso impede cadastrar dois Pikachus seguidos de propósito.
- A carta "sai de cena" quando o OCR passa 4 quadros sem achar nome (`EMPTY_FRAMES_TO_RESET`). O OCR falha também com reflexo, foco ou mão na frente, então "sem nome" não quer dizer "sem carta".
- O que dá para trazer:
  1. trocar "sem nome por N quadros" por "sem carta por N quadros". Pode ser o detector de objetos do ML Kit (há plugin para o vision-camera) ou um teste barato de presença: retângulo grande e claro na moldura, ou diferença de brilho contra o fundo vazio;
  2. com isso, liberar a mesma carta (inclusive não-básica) sempre que houver um "saiu e voltou" de verdade. Manter o intervalo mínimo entre cadastros só contra tremida;
  3. detectar troca rápida por salto de posição ou tamanho da caixa, como o `BoundingBoxMovementAnalyzer`;
  4. dar desfazer rápido na última adição, porque nenhuma das duas formas é perfeita.

## 8. Outros idiomas

- O LigaPkm **não** reconhece outros idiomas. A ajuda diz que o scan aceita "português ou inglês", e a tela do scanner começa com "O scanner reconhece apenas cartas em portugu[ês]...".
- O APK só tem o modelo de OCR latino do ML Kit (`gocr_models/.../Latn_ctc`). Não há modelo japonês, chinês nem coreano. O `libtranslate_jni.so` e o `tflite_langid` vêm junto com o pacote do ML Kit, mas nenhum texto do app indica tradução no scanner.
- Uma carta em espanhol, francês ou alemão teria a numeração lida (ela é latina e igual em todo idioma). Mas o nome não casaria com a base PT/EN, então o resultado tenderia a ficar com nota baixa ou ambíguo. Carta japonesa de Pokémon tem outra numeração e outras coleções, e fica fora.

### Para o Magic é mais fácil que para Pokémon

- Desde M15, o rodapé de **todas** as cartas de Magic, em qualquer idioma, tem a mesma linha latina: `0123/280 R` e `NEO • JA` (ou `• DE`, `• PT`, `• ZHS`...). Até a carta japonesa traz o rodapé em letras latinas.
- Então o modelo latino basta para ler set, número **e idioma** de qualquer carta moderna. Com isso, `https://api.scryfall.com/cards/{set}/{numero}/{idioma}` (ou o índice local) devolve a impressão exata naquele idioma, sem depender do nome.
- O nome vira só confirmação. Para isso o Grimório já tem o seletor de script (latino, japonês, chinês, coreano) em `ocr.ts`. Ele só é preciso quando o rodapé falha ou a carta é anterior a 2014.
- Os códigos impressos são EN, PT, ES, FR, DE, IT, RU, **JP** (japonês), **KR** (coreano), **CS** (chinês simplificado) e **CT** (chinês tradicional). No Scryfall viram `en, pt, es, fr, de, it, ru, ja, ko, zhs, zht`. Tabela em `mtgdeck_app/src/recognition/footer.ts` (`PRINTED_LANG`). No índice local de impressões (item C da seção 5), cada linha precisaria do `lang`. Isso pede o bulk `all_cards`, bem maior que o `default_cards`, ou só os campos (set, número, lang, nome impresso).
- Para preço na Liga, o idioma é atributo da oferta e não muda a edição: a busca de preço continua pela edição, e o filtro de idioma da Liga fica como passo extra.

## 9. Teste de rodapé no Scryfall (03/11/2026)

| Rodapé | Scryfall | Carta |
|---|---|---|
| `U 0071` / `SOA JP` | `cards/soa/71/ja` | Hop to It (跳び込め), Secrets of Strixhaven Mystical Archive, arte japonesa exclusiva, showcase borderless, só não-foil |
| `R 0057` / `SOA EN` | `cards/soa/57/en` | Shamanic Revelation, Secrets of Strixhaven Mystical Archive, borderless showcase, não-foil ou foil |

- Hop to It tem 16 impressões, e o rodapé separa todas. SOA 6 é a versão comum do Archive (em 6 idiomas), SOA 71 é a arte japonesa não-foil e SOA 136 é a mesma arte japonesa só foil. Shamanic Revelation tem 104 impressões, e SOA 57 EN é uma só.
- Cuidados para o leitor:
  - o código impresso é `JP`, mas o Scryfall usa `ja`. Outros casos: `CS`/`CT` → `zhs`/`zht`, `KR` → `ko`. A tabela de conversão está em `footer.ts`;
  - nas coleções novas, a raridade vem antes do número e sem total (`U 0071`). O `extractEdition()` atual só aceita `123/350` ou `210 R`, e também exige o `•` junto do set. Precisa aceitar `[CURMSLT] \d{3,4}` e set sem bullet;
  - zeros à esquerda saem (`0071` → `71`);
  - os números da The List vêm como `BLC-237` (set de origem + número).

## 10. Cartas anteriores a 2014 (sem a linha set/idioma)

Não há um identificador único impresso, mas há várias pistas. O caminho é partir do **nome** (que, antes de 2014, volta a ser a chave) e ir cortando as impressões dele:

| Época | O que a carta traz | Como usar |
|---|---|---|
| 2003 (8ED) a 2014 (M14), moldura moderna | `123/350` no rodapé esquerdo, ano no copyright | Nome + total `350`: casa com o tamanho impresso do set (`printed_size` no Scryfall). Quase sempre sobra uma impressão |
| 1998 (Exodus) a 2003, moldura antiga | `123/143` no rodapé central, junto do copyright | Igual: nome + número/total |
| 1993 a 1998 (Alpha até Tempest) | Sem número. Só o símbolo de expansão (a partir de Arabian Nights; os básicos 4ED/5ED não têm), a borda e o copyright | Nome + borda + símbolo + arte |

Pistas extras para as antigas:
- **Borda:** preta, branca (Unlimited, Revised, 4ED a 7ED e as reimpressões) ou dourada (Collector's Edition e World Championship).
- **Moldura:** antiga (até 2003), moderna (2003 a 2014) ou M15. Dá para saber pelo formato da caixa de texto e da linha de tipo. Também é um corte barato.
- **Cor do símbolo:** desde Exodus indica a raridade (preto, prata, ouro, laranja).
- **Ano no copyright** (`© 1995 Wizards`): separa reimpressões do mesmo símbolo.
- **Arte:** com 1 a 30 impressões de um nome, comparar a área da arte (hash perceptual) contra as imagens do Scryfall dessas impressões resolve quase tudo que as pistas de texto não resolvem. Esse é o `recognizeByArt` que hoje é stub.
- **Idioma:** pelo próprio nome lido (o índice já tem os nomes impressos por idioma) ou pelo script escolhido.
- **Foil:** antes de M15 não há marca impressa. Deixar o usuário marcar.

Casos que vão continuar pedindo escolha: Alpha × Beta × Unlimited (mesma arte; muda o canto e a borda), Revised × 4ED com a mesma arte, e reimpressões idênticas. Para esses, mostrar os 2 ou 3 candidatos com imagem.

## 11. Ordem de checagem proposta para o Grimório

A regra é fazer o mais barato e mais preciso primeiro e parar assim que houver uma resposta segura. Cada etapa só roda se a anterior não decidiu.

**Antes do scanner (uma vez por dia, em segundo plano):** índice local de nomes (já existe) e índice local de impressões (`set`, número, `lang`, nome EN e impresso, `printed_size` do set, borda, moldura, `finishes`, id da imagem). Sem ele, cada etapa vira chamada de rede.

| # | Etapa | Custo | Roda quando | Decide quando |
|---|---|---|---|---|
| 1 | **Presença e estabilidade**: há um retângulo de carta na moldura, parado por cerca de 3 quadros | Muito baixo, imagem reduzida | Todo quadro | Não decide. Só libera o OCR e abre uma "sessão" (sai do quadro → sessão nova, seção 7) |
| 2 | **OCR do rodapé** (faixa inferior recortada e ampliada) → `R 0057` + `SOA • EN` / `★` | Baixo (OCR numa faixa pequena) | Até 5 quadros da sessão | Mesma dupla (set, número) lida 3 vezes e encontrada no índice → **fim**. Idioma e foil (`★`) vêm junto |
| 3 | **OCR do cabeçalho** (faixa do nome) → nome resolvido no índice | Baixo | O rodapé não decidiu (leitura parcial, set duvidoso ou carta antiga) | Nome + o que sobrou do rodapé (só o número, ou `123/350` → total = `printed_size`) deixam 1 impressão → **fim** |
| 4 | **Traços visuais baratos**: cor da borda, moldura (antiga, moderna, M15) | Muito baixo (média de pixels em regiões fixas) | Sobrou mais de 1 impressão do nome | Fica 1 → **fim** |
| 5 | **Arte**: hash perceptual da área da arte contra só os candidatos restantes (imagens do Scryfall, hash guardado em cache) | Médio (baixa as imagens dos candidatos uma vez) | Sobraram 2 ou mais e as imagens diferem | Melhor distância com folga clara sobre a 2ª → **fim** |
| 6 | **Escolha do usuário** entre os 2 ou 3 restantes, com imagem | Zero | Arte igual (Alpha/Beta/Unlimited, reimpressões) ou empate | A escolha fica gravada como aprendida |

Regras de economia:
- OCR só em recortes, nunca na imagem inteira, e no máximo de 3 a 4 leituras por segundo.
- Depois de decidir, para tudo até a carta sair do quadro: a mesma sessão não reprocessa.
- Se o rodapé não mostrar nenhum padrão em cerca de 3 quadros, a carta provavelmente é antiga. Para de tentar o rodapé e passa para o cabeçalho, sem gastar os 5 quadros.
- O recorte do rodapé cobre a faixa inteira de baixo: nas cartas de 1998 a 2003, o número fica no centro, não à esquerda.
- O cabeçalho só é lido no caminho moderno se o rodapé veio fraco (por exemplo, 2 votos em 5, ou set corrigido por aproximação). Aí vale um único OCR do nome para conferir, sem votação.
- Foil: `★` na etapa 2. Sem a marca, fica como opção do usuário na confirmação.
- O preço da Liga só é buscado depois da impressão decidida (edição + foil).

## 12. Câmera e pré-processamento (por que o LigaPkm lê de longe)

Fonte: textos e símbolos de `libnative_opencv.so` (código próprio em `native/filters.cpp` e `native/image_processor.cpp`, OpenCV compilado junto) e o log do CameraX no emulador.

**Resolução: não é o segredo.** Os quadros de teste do próprio app são 1280×960 e 1280×720 (NV21). A câmera usa Preview + ImageCapture + ImageAnalysis do CameraX. No emulador, todos os fluxos saíram em 1280×720 (limite da câmera virtual). O ganho vem do que eles fazem com o quadro antes do OCR.

Pipeline nativo, na ordem dos logs:

1. `[PRE]`: recebe o quadro e a caixa do detector (`detectorRect`). `getValidCard` recusa caixa inválida ou pequena demais ("Bounding box menor que o minimo para preprocessamento nativo").
2. `[ROTATE]`: mede a inclinação da carta (`computeRotationDeltaFromDetectorRect`, `tilt`), gira e recorta a carta do quadro (`extractCardFromRotatedFrame`). Abaixo de um limite de inclinação, não gira. `[ROTATE-BATCH]` trava o ângulo achado e o reaproveita nos quadros seguintes, sem recalcular.
3. `[ROI]`: recorta as regiões da carta já endireitada: cabeçalho (`cropCardHeader`) e rodapé esquerdo ou direito (`cropCardIdentify`, `cropCardIdentifyRight`). Cada uma tem uma área base e uma área expandida com margem.
4. `[AUTO-PARAMS]`: mede o histograma da região (média, p05, p50, p95, contraste, sombras, luzes), classifica a exposição (`SUBEXPOSTA`, `SUPEREXPOSTA`, normal) e calcula contraste, brilho e gama para corrigir.
5. `[FOIL]` e `[SUP]`/`[SUP-CC]`: mede o reflexo (limiares de valor, saturação e contraste em HSV). Se passar do limite, suprime as manchas de brilho do cabeçalho e do rodapé, com componentes conexos e área mínima. É o tratamento para foil e luz refletida.
6. `[FOOTER-VARIANT]`: gera mais de uma versão do rodapé (por exemplo `aggressive_clahe_sharpen`: CLAHE + nitidez; também há limiar adaptativo e Otsu) e manda as versões para o OCR. Fica a que der leitura válida.
7. O resultado volta em NV21 para o ML Kit ("Erro ao converter Mat para NV21"). O OCR roda só nos recortes, já endireitados, ampliados e corrigidos.

Na parte Dart: detector de objetos do ML Kit para a caixa, classificador TFLite `card`/`not_card`, analisador de movimento da caixa e votação entre quadros (seções 2 e 7).

### O nosso hoje (`mtgdeck_app/src/screens/LiveScanScreen.tsx`)

- `useFrameOutput` sem `targetResolution` → padrão da lib, `HD_16_9` (1280×720). É a mesma ordem de grandeza do LigaPkm.
- OCR do quadro **inteiro** em todo quadro (`recognizer.scanFrame`), sem recorte, sem endireitar, sem correção de exposição e sem tratamento de reflexo. O `scanRegion` da lib foi desligado porque quebrava a leitura.
- Numa imagem 1280×720 com a carta ocupando metade da altura, a linha do rodapé de Magic tem 5 a 7 px de altura. O ML Kit precisa de cerca de 16 px por caractere. Por isso o nome (fonte grande) sai e o rodapé não.
- No modo "Nome + edição", a foto é tirada em FHD 4:3, mas também passa inteira pelo OCR.
- O que já fazemos melhor que eles: OCR japonês, chinês e coreano, índice local de nomes com aproximação, `printed_name` PT, zoom 1×/2×/3×, toque para focar, hash de arte (`imageHash.ts`) para escolher a impressão, lista "Adicionadas" com desfazer, modo retirar, básicos repetidos e integração com deck e coleção.

## 13. Outras ideias vistas nos apps da Liga (antes de implementar)

Verificado no app ou no binário:
- **Ajuste remoto:** Firebase Remote Config ("Falha ao atualizar Remote Config") e chaves no `.env`. Exemplos: `TENSOR_FLOW_DETECTION`, `CAMERA_DEBUG_VERSION`, `SHOW_TUTORIAL`, `TELEMETRY_*` e a versão mínima do app (`android_app_latest_version`, banner "ATUALIZAR AGORA"). Para o Grimório: um `scanner-config.json` na release do `mtg-deck-data` com limiares, ritmo de OCR e liga/desliga de etapas, lido junto do manifest.
- **Modo de depuração da câmera** (`CAMERA_DEBUG_VERSION`) e log por etapa (`[PRE]`, `[ROI]`, `[AUTO-PARAMS]`, `[SUP]`, `[FOOTER-VARIANT]`). Para nós, uma camada que desenha o quadrilátero e as regiões e mostra os recortes e as métricas é a ferramenta da Fase 0.
- **Telemetria com orçamento:** sincroniza a cada 30 s com recuo, e **não envia enquanto o scanner está aberto** ("skip sync on scanner route").
- **Tutorial na primeira vez**, ajuda "quais cartas posso escanear" e selo "Beta" para ajustar a expectativa.
- **Correção manual da numeração** no próprio scanner.
- **Resultado com menor/médio/maior em cores** e botão para a página da carta no marketplace. Para nós: link para a página da Liga da edição reconhecida.
- **App híbrido:** scanner nativo e marketplace em WebView (`flutter_inappwebview`). É o mesmo desenho que planejamos para os preços.
- **Base do dia:** `appligapokemon_encrypted_AAAAMMDD.zip`, gerada por volta das 10h GMT. Só existe o arquivo do dia (o de ontem dá 404). O nosso manifest com delta é mais econômico.
- O app da LigaMagic (v2026.04.2416) **não** tem scanner: o APK não traz ML Kit, TFLite nem OpenCV. Mas a pasta do projeto do LigaPkm se chama `aplicativos-da-liga-com-scanner`, o que indica que o scanner deve chegar aos outros apps da Liga.
- Microsoft Clarity grava a sessão de uso. Não vale copiar (privacidade).

Da LigaMagic (sessões anteriores do ESTUDO-LIGAMAGIC.md):
- Preço por extra (normal, foil, etched e outros códigos) e por impressão com número de colecionador.
- Coleção com totais separados normal e foil, e exportação em vários formatos, inclusive "Exportar Edições".
- Cadastro de lista com conferência de nome e edição antes de salvar (`getCardsCheck.php`).
- Deck com dois totais: menor preço em qualquer edição e preço da edição da lista. Dá a função "trocar para a edição mais barata".

O Grimório já tem tela ligada durante o scan (`useKeepScreenOn.ts`).

## 14. Teste no celular real (Galaxy S21 FE, Android 16, 03/11/2026)

Registros do aparelho por USB (`adb logcat`, 15:23:38 a 15:24:49). Bruto em `scratchpad/real/pkm.txt`.

- **Resolução real:** quadros de análise e ImageCapture em **1280×720**, a mesma do emulador. O app não pede resolução alta, nem em aparelho bom.
- **Ritmo:** 52 quadros processados em ~70 s, em lotes de 3 (`ROTATE-BATCH`), só quando a carta está estável. Cada quadro gera **2 chamadas de OCR** (104 no total), de 130 a 330 ms cada.
- **Tamanho da carta no quadro:** de 351×490 px (mais longe) a 572×749 px (mais perto), num quadro de 720×1280 em pé. Mesmo "de longe", a carta ocupou pelo menos ~38% da altura.
- **Rodapé:** recorte base de 83×35 a 134×56 px, expandido para cerca de 250×90 e **ampliado para ~500×190** antes do OCR (cerca de 4× o recorte base).
- **Rotação:** aplicada em 36 quadros e ignorada em 8 (inclinação abaixo de 7°).
- **Exposição** (104 medições, cabeçalho e rodapé): 73 superexpostas, 18 normais, 13 subexpostas. A correção de luz entrou quase sempre.
- **Reflexo:** supressão `very_high` 18 vezes, `high` 16, `low` 11, `medium` 2. A carta de cabeçalho com reflexo (`applyHeader=1`) apareceu em 35 dos 52 quadros.
- **Variante do rodapé:** `standard` 38, `aggressive_clahe_sharpen` 14 (a agressiva entra quando há reflexo ou pouco contraste).
- **Rodapé direito:** não usado neste teste.
- **O texto lido não aparece no log.** O app não imprime o OCR em versão de produção. O texto vai só para a telemetria (planilha Google, HTTPS).

Para o Grimório: confirma que 1280×720 basta **se** houver recorte, endireitamento, correção de luz e reflexo e ampliação de ~4× do rodapé. Também mostra que a correção de reflexo não é um caso raro: entrou na maior parte dos quadros.

## 15. Resultados vistos na tela do celular (03/11/2026, 15:32 a 15:35)

| Hora | Resultado mostrado | Observação |
|---|---|---|
| 15:32:23 | Varoom (124/167) TWM · R$ 0,10 a R$ 1,50 | Primeira carta. Tutorial em balões ("Título da carta", "Comprar carta", "Detalhes") |
| 15:32:43 | Orthworm ex (162/142) SCR · R$ 4,90 a R$ 19,90 | Número maior que o total (rara secreta) resolvido |
| 15:32:51 | Meltan (045/078) PGO · R$ 0,24 a R$ 2,99 | |
| 15:33:07 | Meltan (152/197) OBF · R$ 0,20 a R$ 1,50 | **Mesmo nome, outra coleção**: separado pelo número |
| 15:33:54 | "Reconhecimento de cartas com numeração a direita ativado!" | Caixa da direita tocada (carta antiga) |
| 15:33:56 a 15:34:08 | Busca manual "Buscar carta por numeração": `74/` lista Altaria 74/108, Beheeyem 74/162...; `74/95` lista Energy Returner, Strength Charm e Totodile → Energy Returner (74/95) UL · R$ 0,26 a R$ 3,90 | Carta de 2010 (HGSS Unleashed), número no canto direito. **O número com total ainda tem 3 cartas**, porque várias coleções têm 95 cartas. A escolha final foi do usuário |
| 15:34:38 | Site da LigaPokemon aberto dentro do app | Botão COMPRAR ou DETALHES (WebView) |
| 15:34:50 | Saguaro (187/193) PAL · R$ 0,25 a R$ 1,90 | |
| 15:35:06 | Orthworm ex (162/142) SCR | Mesma carta de novo, reconhecida outra vez |
| 15:35:16 | Orthworm (151/193) PAL · R$ 0,35 a R$ 4,50 | Mesmo nome sem "ex", outra coleção |
| 15:35:30 | Melmetal ex (104) SVP · R$ 2,90 a R$ 49,90 | Promo sem total. Carta holo em português, inclinada, desfocada, com reflexo forte e parte fora da moldura. Ainda assim acertou |

Outras observações:
- Moldura **laranja** enquanto lê, **verde** quando reconhece. O resultado fica embaixo até a próxima carta.
- O resultado mostra nome, `(número/total)`, sigla da coleção, menor e maior preço (não o médio), e os botões COMPRAR e DETALHES, que abrem o site no app.
- A busca manual por numeração filtra conforme a digitação e mostra os candidatos. Cartas de energia ficam de fora ("Busca indisponível para cartões de energia", com link para uma página própria).
- Do aparecimento da carta até o resultado: 1 a 6 s pelos registros (lotes de 3 quadros a cada 1 a 3 s).
- Nas cartas deste teste, a carta ocupou de 400×560 a 650×890 px no quadro 720×1280.

Para o Magic: o caso Energy Returner confirma que, sem código de coleção, **número e total não bastam** (várias coleções do mesmo tamanho). No Magic de 1998 a 2014 vai acontecer o mesmo, e o nome desempata. A busca manual por número com lista de candidatos é uma boa saída para quando a leitura falhar.
