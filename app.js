/* global pdfjsLib, Blockly */

"use strict";

// As libs vêm de CDN. Se uma delas não carregar (offline, rede da empresa,
// bloqueador), o antigo acesso direto a `pdfjsLib` aqui em cima estourava um
// ReferenceError na primeira linha do arquivo: nada mais era definido e a
// toolbar inteira ficava sem listeners — clicar em "Abrir PDF" não fazia nada,
// sem nenhuma pista para o usuário.
const LIB_PDFJS = typeof pdfjsLib !== "undefined";
const LIB_BLOCKLY = typeof Blockly !== "undefined";

if (LIB_PDFJS) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ---------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------
let selectionMode = false;
let workspace = null;

// Paleta cíclica de cores: uma por PDF aberto. `hex` colore borda/swatch/bloco,
// `soft` é a versão translúcida usada em ::selection e no overlay de extração.
const PDF_COLOR_PALETTE = [
  { hex: "#2563eb", soft: "rgba(37,99,235,.45)" },
  { hex: "#16a34a", soft: "rgba(22,163,74,.45)" },
  { hex: "#d97706", soft: "rgba(217,119,6,.45)" },
  { hex: "#db2777", soft: "rgba(219,39,119,.45)" },
  { hex: "#7c3aed", soft: "rgba(124,58,237,.45)" },
  { hex: "#0891b2", soft: "rgba(8,145,178,.45)" },
  { hex: "#dc2626", soft: "rgba(220,38,38,.45)" },
  { hex: "#65a30d", soft: "rgba(101,163,13,.45)" },
];
let paletteIndex = 0;
function nextPdfColor() {
  return PDF_COLOR_PALETTE[paletteIndex++ % PDF_COLOR_PALETTE.length];
}

// O corpo do bloco recebe o `hex` do PDF, mas o campo de texto do Blockly
// desenha um retangulo branco por cima que cobre quase toda a area: sobrava uma
// moldura de poucos pixels e o bloco nao lia como sendo da cor do PDF. Pintar
// esse retangulo com a mesma mistura que o realce da selecao usa (a cor a 45%
// sobre o branco da pagina) faz o bloco e o trecho selecionado ficarem do mesmo
// tom.
const PDF_TINT_ALPHA = 0.45;

function tintFromHex(hex, alpha = PDF_TINT_ALPHA) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(255 + (c - 255) * alpha);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

// Diferente de tintFromHex, que devolve cor solida (a mistura com branco que
// substitui o fundo branco do campo do bloco), aqui a cor precisa ser mesmo
// translucida: a marca fica sobre o texto renderizado do PDF, e um preenchimento
// solido escondia o trecho em vez de destaca-lo.
function rgbaFromHex(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Cores de revisão: marcam trechos do texto do bloco (Alt+1..4 na edição) e
// também servem para trocar a cor do bloco inteiro pelo menu de contexto. O
// projeto guarda o `id`, então mudar um `hex` aqui recolore o que já foi salvo.
const MARCA_CORES = [
  { id: "conferido", nome: "Conferido", hex: "#16a34a", tecla: "1" },
  { id: "duvida", nome: "Dúvida", hex: "#eab308", tecla: "2" },
  { id: "corrigir", nome: "Corrigir", hex: "#dc2626", tecla: "3" },
  { id: "nota", nome: "Nota", hex: "#2563eb", tecla: "4" },
];
const MARCA_ALPHA = 0.38;
const COR_BLOCO_PADRAO = 160;

function marcaCor(id) {
  return MARCA_CORES.find((c) => c.id === id) || null;
}

// Cor que o bloco mostra: a escolhida pelo usuário vence a do PDF de origem.
function corEfetiva(block) {
  const escolhida = block.corBloco && marcaCor(block.corBloco);
  if (escolhida) return escolhida.hex;
  return block.pdfMeta && block.pdfMeta.color ? block.pdfMeta.color : null;
}

// Sobrevive aos re-renders do Blockly (que recriam os filhos do bloco): a
// custom property fica no <g> raiz, que persiste, e o CSS a le nos descendentes.
function applyPdfTint(block) {
  if (!block || block.type !== "pdf_text") return;
  const root = block.getSvgRoot();
  if (!root) return;
  const tint = tintFromHex(corEfetiva(block) || "");
  if (!tint) {
    root.style.removeProperty("--pdf-block-tint");
    root.classList.remove("pdf-tinted");
    return;
  }
  root.style.setProperty("--pdf-block-tint", tint);
  root.classList.add("pdf-tinted");
}

function aplicarCorBloco(block) {
  block.setColour(corEfetiva(block) || COR_BLOCO_PADRAO);
  applyPdfTint(block);
}

let pdfIdSeq = 0;
const openPdfs = new Map(); // id -> { id, name, color, pdfDoc, cardEl, pagesEl }

// Canvas livre dos PDFs: pan/zoom independentes do zoom do Blockly, e
// posicionamento/z-index dos embeds arrastáveis.
let panX = 0;
let panY = 0;
let zoomLevel = 1;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const EMBED_WIDTH = 420;
// Resolução máxima do bitmap da página, em pixels de canvas por pixel de
// layout. Limita o custo de memória ao ampliar muito.
const MAX_RENDER_SCALE = 4;
let topZ = 1;
let placeCounter = 0;

// MIME type customizado usado para carregar a origem (PDF/cor/retângulos) do
// arraste dentro do próprio dataTransfer — evita depender de uma variável de
// módulo cujo timing entre dragstart/drop pode não ser confiável.
const DRAG_META_TYPE = "application/x-pdf-block-meta";

// Espelho do meta do arraste em curso, usado quando o dataTransfer não devolve
// o tipo customizado no drop. Ver o comentário em initPdfTextDrag().
let lastDragMeta = null;

// ---------------------------------------------------------------
// Atalhos de DOM
// ---------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const pdfPanel = $("#pdf-panel");
const pdfPages = $("#pdf-pages");
const pdfPlaceholder = $("#pdf-placeholder");
const blocklyPanel = $("#blockly-panel");
const blocklyDiv = $("#blocklyDiv");
const btnSelectMode = $("#btnSelectMode");

// ---------------------------------------------------------------
// Toast (feedback rápido)
// ---------------------------------------------------------------
let toastHost = null;
function toast(msg) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 2400);
}

// ---------------------------------------------------------------
// Crachas de acesso a arquivo (File System Access API)
//
// O projeto "leve" guarda so o nome do PDF, e o navegador nao pode abrir um
// arquivo do disco a partir do nome -- e uma trava de seguranca do Chrome. O
// que da para guardar e um FileSystemFileHandle: uma autorizacao, nao o
// conteudo. Ele nao e serializavel em JSON, entao mora no IndexedDB, preso a
// este navegador; o .json continua portatil e cai no seletor de arquivos em
// qualquer outra maquina.
// ---------------------------------------------------------------
const IDB_NAME = "blocky-pdf-editor";
const IDB_STORE = "file-handles";
const TEM_FS_API = typeof window.showOpenFilePicker === "function";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Toda leitura/escrita e best-effort: modo anonimo, cota cheia ou IndexedDB
// desabilitado nao podem impedir de abrir um PDF.
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[handles] leitura falhou:", err);
    return null;
  }
}

async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[handles] gravacao falhou:", err);
  }
}

// Identifica o arquivo em si, nao o PDF dentro deste projeto: o mesmo arquivo
// aberto em dois projetos reaproveita o mesmo cracha.
function fileKeyOf(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

// ---------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------
// Campo de texto do bloco
// ---------------------------------------------------------------
// Largura máxima do texto dentro do bloco. A leitura quebra as linhas nessa
// largura e a caixa de edição herda a mesma largura do bloco, então o texto
// não se reorganiza ao abrir o editor.
const BLOCK_TEXT_WIDTH = 340;

let measureCtx = null;
function measureText(text, font) {
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// Quebra por largura medida (e não por contagem de caracteres) para bater com
// o critério que o <textarea> do editor usa.
//
// Cada linha vem com `start`, sua posição no texto cru: é o que liga as marcas
// de cor (guardadas em offsets do texto) às linhas desenhadas. A linha é sempre
// um recorte do texto cru; o único caractere que some é o espaço da quebra.
function wrapWithOffsets(text, font, maxPx) {
  const out = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    let start = pos;
    let end = pos; // fim (exclusivo) do que já cabe na linha atual
    let p = pos;
    for (const word of line.split(" ")) {
      const wordEnd = p + word.length;
      if (end > start && measureText(text.slice(start, wordEnd), font) > maxPx) {
        out.push({ text: text.slice(start, end), start });
        start = p;
      }
      end = wordEnd;
      p = wordEnd + 1; // pula o espaço
    }
    out.push({ text: text.slice(start, end), start });
    pos += line.length + 1; // pula o "\n"
  }
  return out;
}

function wrapToWidth(text, font, maxPx) {
  return wrapWithOffsets(text, font, maxPx).map((l) => l.text);
}

// A classe estende `Blockly.FieldMultilineInput`, então não pode ser avaliada
// enquanto o Blockly não existir: como declaração de topo, um CDN fora do ar
// derrubava o arquivo inteiro na primeira linha e a toolbar ficava sem nenhum
// listener. Agora ela nasce sob demanda, dentro de `defineBlocks()`.
let BlockTextField = null;

function ensureBlockTextField() {
  if (BlockTextField) return BlockTextField;

  BlockTextField = class extends Blockly.FieldMultilineInput {
    constructor(value) {
      super(value);
      // Por padrão o Blockly corta cada linha em 50 caracteres e mostra "...".
      // Era isso que fazia o bloco mostrar um texto na leitura e outro, bem
      // maior, ao abrir o editor.
      this.maxDisplayLength = Infinity;
    }

    fieldFont() {
      const c = this.getConstants();
      return `${c.FIELD_TEXT_FONTWEIGHT} ${c.FIELD_TEXT_FONTSIZE}pt ${c.FIELD_TEXT_FONTFAMILY}`;
    }

    getDisplayText_() {
      const raw = this.getText();
      if (!raw) return Blockly.Field.NBSP;

      const font = this.fieldFont();
      // O bloco fica com a largura da linha mais larga, e é essa largura que a
      // caixa de edição recebe. Reaplicar a quebra sobre ela faz os dois
      // convergirem para o mesmo ponto de corte.
      let width = BLOCK_TEXT_WIDTH;
      let lines = wrapWithOffsets(raw, font, width);
      for (let pass = 0; pass < 2; pass++) {
        const widest = Math.max(...lines.map((l) => measureText(l.text, font)));
        if (widest >= width - 0.5) break;
        width = widest;
        lines = wrapWithOffsets(raw, font, width);
      }
      // render_() chama este m\u00E9todo logo antes de desenhar: as linhas ficam
      // guardadas para posicionar as marcas sobre elas.
      this.linhas_ = lines;

      let out = lines
        .map((l) => l.text.replace(/\s/g, Blockly.Field.NBSP))
        .join("\n");
      const block = this.getSourceBlock();
      if (block && block.RTL) out += "\u200F";
      return out;
    }

    // O Blockly desenha um <text> por linha. As marcas s\u00E3o ret\u00E2ngulos atr\u00E1s
    // deles, num <g> pr\u00F3prio fora do `textGroup`: o updateSize_ do Blockly soma
    // a altura de cada filho do `textGroup`, e um filho a mais cresceria o bloco.
    render_() {
      this.linhas_ = null;
      super.render_();
      this.desenharMarcas_();
    }

    desenharMarcas_() {
      const block = this.getSourceBlock();
      if (!this.fieldGroup_ || !this.textGroup) return;
      if (!this.grupoMarcas_ || this.grupoMarcas_.parentNode !== this.fieldGroup_) {
        this.grupoMarcas_ = document.createElementNS(SVG_NS, "g");
        this.grupoMarcas_.setAttribute("class", "bloco-marcas");
      }
      // Sempre logo antes do texto, para ficar por tr\u00E1s dele.
      this.fieldGroup_.insertBefore(this.grupoMarcas_, this.textGroup);
      const g = this.grupoMarcas_;
      while (g.firstChild) g.removeChild(g.firstChild);

      const marcas = (block && block.marcas) || [];
      if (!marcas.length || !this.linhas_ || !this.getText()) return;

      const textos = this.textGroup.querySelectorAll("text");
      this.linhas_.forEach((linha, i) => {
        const el = textos[i];
        const fim = linha.start + linha.text.length;
        if (!el || !linha.text.length) return;
        for (const m of marcas) {
          const a = Math.max(m.start, linha.start) - linha.start;
          const b = Math.min(m.end, fim) - linha.start;
          if (b <= a) continue;
          const cor = marcaCor(m.cor);
          if (!cor) continue;
          try {
            // Medida pelo pr\u00F3prio <text>: bate com o que est\u00E1 na tela, com a
            // fonte que o navegador de fato usou.
            const x0 = el.getStartPositionOfChar(a).x;
            const x1 = el.getEndPositionOfChar(b - 1).x;
            const box = el.getBBox();
            const r = document.createElementNS(SVG_NS, "rect");
            r.setAttribute("x", String(x0));
            r.setAttribute("y", String(box.y));
            r.setAttribute("width", String(Math.max(1, x1 - x0)));
            r.setAttribute("height", String(box.height));
            r.setAttribute("rx", "2");
            r.setAttribute("fill", rgbaFromHex(cor.hex, MARCA_ALPHA));
            g.appendChild(r);
          } catch (_) {
            // Bloco oculto (flyout fechado, colapsado): sem geometria para medir.
          }
        }
      });
    }

    // Enquanto o usu\u00E1rio digita, as marcas acompanham o texto. S\u00F3 durante a
    // edi\u00E7\u00E3o: ao carregar um projeto o estado extra chega antes do valor do
    // campo, e um ajuste aqui destruiria as marcas rec\u00E9m-carregadas.
    doValueUpdate_(novo) {
      const antigo = this.value_;
      const block = this.getSourceBlock();
      if (
        this.isBeingEdited_ &&
        block &&
        block.marcas &&
        block.marcas.length &&
        typeof antigo === "string" &&
        typeof novo === "string"
      ) {
        block.marcas = ajustarMarcasPorEdicao(block.marcas, antigo, novo);
      }
      super.doValueUpdate_(novo);
    }

    widgetCreate_() {
      const input = super.widgetCreate_();
      const block = this.getSourceBlock();
      // Retrato das marcas ao abrir: ao fechar, vira um \u00FAnico evento de
      // desfazer, no mesmo grupo da edi\u00E7\u00E3o de texto que o Blockly j\u00E1 abre.
      this.estadoAoAbrir_ = block ? estadoExtraJson(block) : "";
      input.classList.add("bloco-texto-editor");
      if (this.fieldGroup_) this.fieldGroup_.classList.add("editando-marcas");
      mostrarPaletaMarcas(this);
      return input;
    }

    widgetDispose_() {
      const block = this.getSourceBlock();
      esconderPaletaMarcas();
      if (this.htmlInput_) this.lastCaret = this.htmlInput_.selectionStart;
      if (this.fieldGroup_) this.fieldGroup_.classList.remove("editando-marcas");
      if (block && Blockly.Events.isEnabled()) {
        const agora = estadoExtraJson(block);
        if (this.estadoAoAbrir_ != null && agora !== this.estadoAoAbrir_) {
          Blockly.Events.fire(
            new Blockly.Events.BlockChange(block, "mutation", null, this.estadoAoAbrir_, agora)
          );
        }
      }
      this.estadoAoAbrir_ = null;
      super.widgetDispose_();
    }

    onHtmlInputKeyDown_(e) {
      const block = this.getSourceBlock();
      const input = this.htmlInput_;

      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (block && input) splitTextBlock(block, input.selectionStart, input.value);
        return;
      }

      // e.code e n\u00E3o e.key: com Alt, alguns layouts trocam o caractere da tecla.
      const tecla = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || "");
      if (tecla && e.altKey && !e.ctrlKey && !e.metaKey && block && input) {
        const corId =
          tecla[1] === "0" ? null : (MARCA_CORES.find((c) => c.tecla === tecla[1]) || {}).id;
        if (corId !== undefined) {
          e.preventDefault();
          grifarSelecao(this, corId);
          return;
        }
      }

      super.onHtmlInputKeyDown_(e);
    }

    // Durante a edição o Blockly ignora o texto exibido e dimensiona o campo
    // pela linha mais longa do valor cru, sem quebra: o bloco esticava para a
    // largura do parágrafo inteiro no instante do clique. Aqui ele continua
    // usando a medida do texto quebrado, então a caixa de edição nasce com a
    // mesma largura da leitura e quebra nos mesmos pontos.
    updateSize_() {
      const editando = this.isBeingEdited_;
      this.isBeingEdited_ = false;
      try {
        super.updateSize_();
      } finally {
        this.isBeingEdited_ = editando;
      }
    }
  };

  return BlockTextField;
}

// ---------------------------------------------------------------
// Definição do bloco de texto
// ---------------------------------------------------------------
function defineBlocks() {
  ensureBlockTextField();

  Blockly.Blocks["pdf_text"] = {
    init: function () {
      this.appendDummyInput().appendField(
        new BlockTextField("Digite o texto aqui..."),
        "TEXT"
      );
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(160); // cor padrão para blocos criados manualmente (toolbox)
      this.setTooltip(
        "Bloco de texto. Arraste para mover, encaixe para ordenar, edite o conteúdo clicando nele."
      );
    },
    // Persiste a cor/origem do PDF, as marcas e a cor escolhida junto ao bloco
    // (setColour em tempo de execução não é salvo pela serialização do Blockly).
    // Os campos do PDF ficam no nível de cima, como antes, para projetos antigos
    // continuarem abrindo.
    saveExtraState: function () {
      const state = this.pdfMeta ? { ...this.pdfMeta } : {};
      if (this.marcas && this.marcas.length) {
        state.marcas = this.marcas.map((m) => ({ ...m }));
      }
      if (this.corBloco) state.corBloco = this.corBloco;
      return Object.keys(state).length ? state : null;
    },
    // Também é o caminho do Ctrl+Z (BlockChange "mutation" chama com `{}`),
    // então precisa zerar o que não vier no estado.
    loadExtraState: function (state) {
      const { marcas, corBloco, ...meta } = state || {};
      this.pdfMeta = meta.color || meta.pdfId ? meta : null;
      this.marcas = Array.isArray(marcas) ? marcas.map((m) => ({ ...m })) : [];
      this.corBloco = corBloco || null;
      aplicarCorBloco(this);
      if (this.rendered) {
        const field = this.getField("TEXT");
        if (field) field.forceRerender();
      }
    },
  };

  defineMarcadores();
}

// ---------------------------------------------------------------
// Marcadores
// ---------------------------------------------------------------
// Blocos que não carregam texto do PDF: entram na mesma pilha dos trechos e
// só influenciam a montagem do arquivo final. A aparência mora aqui e o
// efeito mora no `switch` de montarPilha() — um marcador novo é sempre esses
// dois pontos, nada mais.
const COR_PILHA = 210; // cabeçalho de pilha
const COR_LAYOUT = 260; // espaçamento e separadores escritos no .txt
const COR_NOTA = 60; // nunca exporta

function defineMarcadores() {
  // Cabeçalho de pilha. Sem conexão anterior de propósito: o próprio Blockly
  // impede encaixá-lo no meio de uma pilha, então esse estado inválido não
  // chega a existir e não precisa ser validado depois.
  Blockly.Blocks["txt_pilha"] = {
    init: function () {
      this.appendDummyInput()
        .appendField("\u25a3 pilha nº")
        .appendField(new Blockly.FieldNumber(1, 1, 99, 1), "ORDEM")
        .appendField(new Blockly.FieldTextInput("sem título"), "ROTULO");
      this.setNextStatement(true, null);
      this.setColour(COR_PILHA);
      this.setTooltip(
        "Fixa a posição desta pilha no texto exportado. Só encaixa no topo de " +
          "uma pilha. O número e o título não vão para o .txt."
      );
    },
  };

  Blockly.Blocks["txt_separador"] = {
    init: function () {
      this.appendDummyInput()
        .appendField("\u2500\u2500 separador")
        .appendField(new Blockly.FieldTextInput("---"), "LINHA");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(COR_LAYOUT);
      this.setTooltip(
        "Escreve esta linha literalmente no .txt, como se fosse um trecho de " +
          "texto. Serve para separar seções."
      );
    },
  };

  Blockly.Blocks["txt_espaco"] = {
    init: function () {
      this.appendDummyInput()
        .appendField("\u23ce")
        .appendField(new Blockly.FieldNumber(2, 1, 10, 1), "QTD")
        .appendField("linha(s) em branco");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(COR_LAYOUT);
      this.setTooltip(
        "Aumenta o espaço antes do próximo trecho. Entre trechos o padrão já é " +
          "uma linha em branco."
      );
    },
  };

  Blockly.Blocks["txt_nota"] = {
    init: function () {
      this.appendDummyInput()
        .appendField("\u203b")
        .appendField(new Blockly.FieldTextInput("anotação"), "NOTA");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(COR_NOTA);
      this.setTooltip("Lembrete para você. Nunca aparece no texto exportado.");
    },
  };
}

// ---------------------------------------------------------------
// Ordem de leitura das pilhas
// ---------------------------------------------------------------
// `workspace.getTopBlocks(true)` ordena quase só por Y (inclina o eixo em 3
// graus), então duas pilhas lado a lado saem na ordem de quem tem o topo mais
// alto — não na ordem das colunas. Para montar um texto de várias pilhas isso
// é imprevisível demais, então a ordem é calculada aqui: coluna a coluna, da
// esquerda para a direita, e cada coluna de cima para baixo. Um cabeçalho
// `txt_pilha` com número tem precedência sobre a geometria.
//
// Tolerância horizontal para duas pilhas contarem como a mesma coluna. Um
// bloco de texto tem ~340px, então pilhas desalinhadas em menos de ~3/4 de
// bloco ainda são "a mesma coluna".
const TOLERANCIA_COLUNA = 260;

function pilhasNaOrdem() {
  if (!workspace) return [];

  const topos = workspace
    .getTopBlocks(false)
    .filter((b) => !b.isShadow() && !b.isInsertionMarker());

  const itens = topos.map((b) => {
    const xy = b.getRelativeToSurfaceXY();
    const cab = b.type === "txt_pilha" ? b : null;
    return {
      block: b,
      x: xy.x,
      y: xy.y,
      ordem: cab ? Number(cab.getFieldValue("ORDEM")) : null,
      rotulo: cab ? cab.getFieldValue("ROTULO") : null,
    };
  });

  const numeradas = itens
    .filter((i) => Number.isFinite(i.ordem))
    .sort((a, b) => a.ordem - b.ordem || a.y - b.y);

  // Colunas ancoradas: a comparação é sempre com o X da primeira pilha da
  // coluna, nunca com a da pilha anterior — senão pilhas espaçadas de 200 em
  // 200px se encadeariam todas numa coluna só.
  const colunas = [];
  const soltas = itens
    .filter((i) => !Number.isFinite(i.ordem))
    .sort((a, b) => a.x - b.x);
  for (const i of soltas) {
    const col = colunas.find((c) => Math.abs(i.x - c.x) <= TOLERANCIA_COLUNA);
    if (col) col.itens.push(i);
    else colunas.push({ x: i.x, itens: [i] });
  }
  const geometricas = colunas.flatMap((c) => c.itens.sort((a, b) => a.y - b.y));

  return [...numeradas, ...geometricas];
}

// ---------------------------------------------------------------
// Selo com o número de leitura da pilha
// ---------------------------------------------------------------
// O selo é um <g> pendurado no próprio SVG do bloco de topo: acompanha
// arraste e zoom sem nenhum listener de viewport, e some junto com o bloco.
const SVG_NS = "http://www.w3.org/2000/svg";
const comSelo = new Set();

function removerSelo(block) {
  const g = block.__seloOrdem;
  if (g && g.parentNode) g.parentNode.removeChild(g);
  block.__seloOrdem = null;
  comSelo.delete(block);
}

function aplicarSelo(block, n) {
  const raiz = block.getSvgRoot();
  if (!raiz) return;
  let g = block.__seloOrdem;
  if (!g || !g.parentNode) {
    g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "stack-badge");
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "-19");
    c.setAttribute("cy", "14");
    c.setAttribute("r", "12");
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", "-19");
    t.setAttribute("y", "18");
    t.setAttribute("text-anchor", "middle");
    g.appendChild(c);
    g.appendChild(t);
    raiz.appendChild(g);
    block.__seloOrdem = g;
    comSelo.add(block);
  }
  g.querySelector("text").textContent = String(n);
}

// ---------------------------------------------------------------
// Validação: mostra na tela o que não vai sair no .txt
// ---------------------------------------------------------------
function escreveAlgo(b) {
  if (b.type === "pdf_text") return !!(b.getFieldValue("TEXT") || "").trim();
  if (b.type === "txt_separador") return !!(b.getFieldValue("LINHA") || "").trim();
  return false;
}

function revalidarWorkspace() {
  const pilhas = pilhasNaOrdem();

  // Selo: com uma pilha só, o número é ruído.
  const mostrarSelo = pilhas.length > 1;
  for (const b of Array.from(comSelo)) {
    if (!mostrarSelo || !pilhas.some((p) => p.block === b)) removerSelo(b);
  }
  if (mostrarSelo) pilhas.forEach((p, i) => aplicarSelo(p.block, i + 1));

  // Dois cabeçalhos com o mesmo número deixam a ordem entre eles indefinida.
  const usados = new Map();
  for (const p of pilhas) {
    if (Number.isFinite(p.ordem)) usados.set(p.ordem, (usados.get(p.ordem) || 0) + 1);
  }

  for (const p of pilhas) {
    const blocos = [];
    for (let b = p.block; b; b = b.getNextBlock()) blocos.push(b);
    const algumTexto = blocos.some(escreveAlgo);

    blocos.forEach((b, idx) => {
      let aviso = null;
      const antes = blocos.slice(0, idx).some(escreveAlgo);
      const depois = blocos.slice(idx + 1).some(escreveAlgo);

      switch (b.type) {
        case "pdf_text":
          if (!(b.getFieldValue("TEXT") || "").trim())
            aviso = "Bloco sem texto: não entra na exportação.";
          break;
        case "txt_espaco":
          if (!antes || !depois) aviso = "Espaço na ponta da pilha: sem efeito.";
          break;
        case "txt_separador":
          if (!(b.getFieldValue("LINHA") || "").trim())
            aviso = "Separador vazio: não escreve nada.";
          break;
        case "txt_pilha":
          if (usados.get(p.ordem) > 1)
            aviso = "Outra pilha usa o mesmo número: a ordem entre as duas fica indefinida.";
          else if (!algumTexto) aviso = "Esta pilha não tem nenhum trecho de texto.";
          break;
      }

      b.setWarningText(aviso);
    });
  }
}

// Durante um arraste os eventos chegam a cada quadro, então a passada é
// adiada e coalescida. `setTimeout` e não `requestAnimationFrame`: o rAF não
// dispara em aba oculta, e uma revalidação agendada ficaria pendurada com a
// flag levantada -- todas as seguintes seriam engolidas até a aba voltar.
let revalidacaoAgendada = false;
function agendarRevalidacao() {
  if (revalidacaoAgendada) return;
  revalidacaoAgendada = true;
  setTimeout(() => {
    revalidacaoAgendada = false;
    try {
      revalidarWorkspace();
    } catch (err) {
      console.error("[marcadores] falha ao revalidar:", err);
    }
  }, 0);
}

function initValidacao() {
  const ESTRUTURAIS = new Set([
    Blockly.Events.BLOCK_CREATE,
    Blockly.Events.BLOCK_DELETE,
    Blockly.Events.BLOCK_MOVE,
    Blockly.Events.BLOCK_CHANGE,
    Blockly.Events.FINISHED_LOADING,
  ]);

  workspace.addChangeListener((e) => {
    if (!ESTRUTURAIS.has(e.type)) return;
    // O próprio aviso é uma BLOCK_CHANGE: ignorá-la corta o ciclo.
    if (e.type === Blockly.Events.BLOCK_CHANGE && e.element === "warning") return;
    agendarRevalidacao();
  });

  agendarRevalidacao();
}

// ---------------------------------------------------------------
// Inicialização do Blockly
// ---------------------------------------------------------------
function initBlockly() {
  defineBlocks();

  // Com marcadores no jogo o flyout único vira uma lista sem contexto: as
  // categorias separam "o que vira texto" de "o que só organiza".
  const toolbox = {
    kind: "categoryToolbox",
    contents: [
      {
        kind: "category",
        name: "Texto",
        colour: "160",
        contents: [{ kind: "block", type: "pdf_text" }],
      },
      {
        kind: "category",
        name: "Marcadores",
        colour: "210",
        contents: [
          { kind: "block", type: "txt_pilha" },
          { kind: "block", type: "txt_separador" },
          { kind: "block", type: "txt_espaco" },
          { kind: "block", type: "txt_nota" },
        ],
      },
    ],
  };

  workspace = Blockly.inject(blocklyDiv, {
    toolbox: toolbox,
    trashcan: true,
    zoom: {
      controls: true,
      wheel: true,
      startScale: 1,
      maxScale: 2,
      minScale: 0.4,
      pinch: true,
    },
    move: {
      scrollbars: { horizontal: true, vertical: true },
      drag: true,
      wheel: true,
    },
    grid: { spacing: 20, length: 3, colour: "#ccc", snap: true },
  });

  window.addEventListener("resize", () => Blockly.svgResize(workspace));

  initValidacao();
}

// ---------------------------------------------------------------
// Cria um bloco pdf_text na posição (de tela) onde foi solto
// ---------------------------------------------------------------
function createTextBlockAt(text, clientX, clientY, meta) {
  const clean = text.trim();
  if (!clean) {
    toast("A seleção está vazia — nada para criar.");
    return null;
  }

  const wsCoord = Blockly.utils.svgMath.screenToWsCoordinates(
    workspace,
    new Blockly.utils.Coordinate(clientX, clientY)
  );

  // Agrupa os eventos: criar + posicionar o bloco desfaz em um Ctrl+Z só.
  Blockly.Events.setGroup(true);
  let block;
  try {
    block = workspace.newBlock("pdf_text");
    block.setFieldValue(clean, "TEXT");
    if (meta && meta.color) {
      block.pdfMeta = { pdfId: meta.pdfId, color: meta.color };
      block.setColour(meta.color);
    }
    block.initSvg();
    block.render();
    applyPdfTint(block);
    block.moveTo(wsCoord);
    block.select();
  } finally {
    Blockly.Events.setGroup(false);
  }

  toast("Bloco criado!");
  return block;
}

// ---------------------------------------------------------------
// Marcas de revisão, cor do bloco e divisão
// ---------------------------------------------------------------
// Mesmo formato que o Blockly usa nos eventos de "mutation" (JSON ou "").
function estadoExtraJson(block) {
  const s = block.saveExtraState();
  return s ? JSON.stringify(s) : "";
}

// Aplica `fn` no bloco e registra um evento desfazível com o antes/depois.
function mudarEstadoBloco(block, fn) {
  const antes = estadoExtraJson(block);
  fn();
  const depois = estadoExtraJson(block);
  if (antes !== depois && Blockly.Events.isEnabled()) {
    Blockly.Events.fire(
      new Blockly.Events.BlockChange(block, "mutation", null, antes, depois)
    );
  }
}

// Ordena, descarta vazias e funde vizinhas da mesma cor.
function normalizarMarcas(marcas, len) {
  const out = [];
  const ordenadas = marcas
    .map((m) => ({ start: Math.max(0, m.start), end: Math.min(len, m.end), cor: m.cor }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start);
  for (const m of ordenadas) {
    const ult = out[out.length - 1];
    if (ult && ult.cor === m.cor && m.start <= ult.end) ult.end = Math.max(ult.end, m.end);
    else out.push(m);
  }
  return out;
}

// Tira o intervalo [ini, fim) das marcas, partindo as que o atravessam.
function recortarMarcas(marcas, ini, fim) {
  const out = [];
  for (const m of marcas) {
    if (m.end <= ini || m.start >= fim) {
      out.push({ ...m });
      continue;
    }
    if (m.start < ini) out.push({ ...m, end: ini });
    if (m.end > fim) out.push({ ...m, start: fim });
  }
  return out;
}

// Só o que está dentro de [ini, fim), deslocado para começar em 0.
function extrairMarcas(marcas, ini, fim) {
  return marcas
    .map((m) => ({
      start: Math.max(m.start, ini) - ini,
      end: Math.min(m.end, fim) - ini,
      cor: m.cor,
    }))
    .filter((m) => m.end > m.start);
}

// Acha o trecho trocado (prefixo e sufixo comuns) e desloca as marcas. Texto
// digitado colado no início de uma marca fica fora dela; no meio, fica dentro.
function ajustarMarcasPorEdicao(marcas, antigo, novo) {
  let p = 0;
  const min = Math.min(antigo.length, novo.length);
  while (p < min && antigo[p] === novo[p]) p++;
  let q = 0;
  while (
    q < min - p &&
    antigo[antigo.length - 1 - q] === novo[novo.length - 1 - q]
  ) {
    q++;
  }
  const fimAntigo = antigo.length - q;
  const delta = novo.length - antigo.length;
  const fimNovo = fimAntigo + delta;

  const inicio = (x) => (x < p ? x : x >= fimAntigo ? x + delta : fimNovo);
  const fim = (x) => (x <= p ? x : x >= fimAntigo ? x + delta : p);

  return normalizarMarcas(
    marcas.map((m) => ({ start: inicio(m.start), end: fim(m.end), cor: m.cor })),
    novo.length
  );
}

// `corId` null apaga. Sem seleção, vale para o texto inteiro. Chamada durante
// a edição, não dispara evento: o widgetDispose_ do campo registra a sessão
// inteira como um passo só de desfazer.
function aplicarMarca(block, ini, fim, corId, len) {
  if (ini === fim) {
    ini = 0;
    fim = len;
  }
  let marcas = recortarMarcas(block.marcas || [], ini, fim);
  if (corId) marcas.push({ start: ini, end: fim, cor: corId });
  block.marcas = normalizarMarcas(marcas, len);
}

// Grifa a seleção do editor aberto (ou o texto todo, sem seleção).
function grifarSelecao(field, corId) {
  const block = field.getSourceBlock();
  const input = field.htmlInput_;
  if (!block || !input) return;
  const { selectionStart: s, selectionEnd: f } = input;
  aplicarMarca(block, s, f, corId, input.value.length);
  field.forceRerender();
  // O re-render não recria o <textarea>; a seleção volta para dar para
  // trocar a cor de novo sem selecionar outra vez.
  input.focus({ preventScroll: true });
  input.setSelectionRange(s, f);
}

function mudarCorBloco(block, corId) {
  const campo = block.getField("TEXT");
  // Com o editor aberto, o widgetDispose_ do campo já registra a sessão
  // inteira como um passo de desfazer.
  if (campo && campo.isBeingEdited_) {
    block.corBloco = corId;
    aplicarCorBloco(block);
    return;
  }
  mudarEstadoBloco(block, () => {
    block.corBloco = corId;
    aplicarCorBloco(block);
  });
}

// ---------------------------------------------------------------
// Paleta de grifo: aparece junto do editor de texto do bloco
// ---------------------------------------------------------------
let paletaMarcas = null;

function mostrarPaletaMarcas(field) {
  esconderPaletaMarcas();
  const block = field.getSourceBlock();
  if (!block) return;

  const el = document.createElement("div");
  el.className = "paleta-marcas";

  const linha = (rotulo) => {
    const l = document.createElement("div");
    l.className = "paleta-linha";
    const s = document.createElement("span");
    s.className = "paleta-rotulo";
    s.textContent = rotulo;
    l.appendChild(s);
    el.appendChild(l);
    return l;
  };
  const botao = (pai, titulo, cor, acao) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "paleta-cor" + (cor ? "" : " paleta-limpar");
    b.title = titulo;
    if (cor) b.style.background = cor;
    else b.textContent = "✕";
    // mousedown sem default: o <textarea> não perde o foco nem a seleção.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", acao);
    pai.appendChild(b);
  };

  const grifo = linha("Grifar");
  for (const c of MARCA_CORES) {
    botao(grifo, `${c.nome} (Alt+${c.tecla})`, rgbaFromHex(c.hex, 0.55), () =>
      grifarSelecao(field, c.id)
    );
  }
  botao(grifo, "Tirar grifo (Alt+0)", null, () => grifarSelecao(field, null));

  const cores = linha("Bloco");
  for (const c of MARCA_CORES) {
    botao(cores, `Cor do bloco: ${c.nome}`, c.hex, () => mudarCorBloco(block, c.id));
  }
  botao(cores, "Cor original do bloco", null, () => mudarCorBloco(block, null));

  document.body.appendChild(el);
  paletaMarcas = el;
  posicionarPaletaMarcas();
  // O Blockly ainda ajusta o tamanho do editor logo depois de criá-lo.
  setTimeout(posicionarPaletaMarcas, 0);
}

function posicionarPaletaMarcas() {
  if (!paletaMarcas) return;
  const r = Blockly.WidgetDiv.getDiv().getBoundingClientRect();
  const h = paletaMarcas.offsetHeight;
  const acima = r.top - h - 6;
  paletaMarcas.style.left = Math.max(4, r.left) + "px";
  paletaMarcas.style.top = (acima >= 50 ? acima : r.bottom + 6) + "px";
}

function esconderPaletaMarcas() {
  if (paletaMarcas) paletaMarcas.remove();
  paletaMarcas = null;
}

// ---------------------------------------------------------------
// Dois cliques na borda do bloco: divide entre as linhas
// ---------------------------------------------------------------
// Clique no texto abre o editor, então a divisão fica na moldura colorida em
// volta dele. O corte cai entre as duas linhas mais próximas da altura do clique.
function initDivisaoPorDuploClique() {
  blocklyDiv.addEventListener("dblclick", (e) => {
    const alvo = e.target instanceof Element ? e.target : null;
    const raiz = alvo && alvo.closest(".blocklyDraggable[data-id]");
    if (!raiz) return;
    const block = workspace.getBlockById(raiz.getAttribute("data-id"));
    if (!block || block.type !== "pdf_text" || block.isInFlyout) return;
    const campo = block.getField("TEXT");
    if (!campo || !campo.fieldGroup_) return;
    if (campo.fieldGroup_.contains(alvo)) return; // clique no texto: é edição

    e.preventDefault();
    const textos = Array.from(campo.textGroup.querySelectorAll("text"));
    const linhas = campo.linhas_ || [];
    if (textos.length < 2 || linhas.length < 2) {
      toast("Este bloco tem uma linha só: não há onde dividir.");
      return;
    }

    let melhor = -1;
    let dist = Infinity;
    for (let i = 1; i < textos.length && i < linhas.length; i++) {
      const y =
        (textos[i - 1].getBoundingClientRect().bottom + textos[i].getBoundingClientRect().top) / 2;
      const d = Math.abs(e.clientY - y);
      if (d < dist) {
        dist = d;
        melhor = i;
      }
    }
    if (melhor < 0) return;
    splitTextBlock(block, linhas[melhor].start, campo.getValue() || "");
  });
}

// Corta o bloco em `pos`: ele fica com o que vem antes e um bloco novo, logo
// abaixo na mesma pilha, fica com o resto. Marcas vão para o lado delas.
function splitTextBlock(block, pos, value) {
  const esquerda = value.slice(0, pos);
  const direita = value.slice(pos);
  const antes = esquerda.trim();
  const depois = direita.trim();
  if (!antes || !depois) {
    toast("Posicione o cursor no meio do texto para dividir o bloco.");
    return null;
  }

  const iniA = esquerda.length - esquerda.trimStart().length;
  const iniB = pos + (direita.length - direita.trimStart().length);
  const marcas = block.marcas || [];
  const marcasA = extrairMarcas(marcas, iniA, iniA + antes.length);
  const marcasB = extrairMarcas(marcas, iniB, iniB + depois.length);

  // Fecha o editor antes: é ele que registra a edição em curso como um passo
  // de desfazer separado deste.
  Blockly.WidgetDiv.hide();

  Blockly.Events.setGroup(true);
  let novo;
  try {
    block.setFieldValue(antes, "TEXT");
    mudarEstadoBloco(block, () => {
      block.marcas = marcasA;
    });

    novo = workspace.newBlock("pdf_text");
    novo.setFieldValue(depois, "TEXT");
    novo.initSvg();
    novo.render();
    // Com evento: o Ctrl+Y recria o bloco a partir do evento de criação, que
    // só conhece o estado inicial.
    mudarEstadoBloco(novo, () => {
      novo.loadExtraState({
        ...(block.pdfMeta || {}),
        marcas: marcasB,
        corBloco: block.corBloco,
      });
    });

    const seguinte = block.getNextBlock();
    if (seguinte) seguinte.previousConnection.disconnect();
    block.nextConnection.connect(novo.previousConnection);
    if (seguinte) novo.nextConnection.connect(seguinte.previousConnection);

    const campo = block.getField("TEXT");
    if (campo) campo.forceRerender();
    novo.select();
  } finally {
    Blockly.Events.setGroup(false);
  }

  toast("Bloco dividido.");
  return novo;
}

// ---------------------------------------------------------------
// Drag & drop de TEXTO sobre o workspace Blockly
// ---------------------------------------------------------------
function isTextDrag(e) {
  const types = Array.from(e.dataTransfer ? e.dataTransfer.types : []);
  return types.includes("text/plain") && !types.includes("Files");
}

function initBlocklyDrop() {
  blocklyDiv.addEventListener("dragover", (e) => {
    if (!isTextDrag(e)) return;
    e.preventDefault();
    if (selectionMode) {
      e.dataTransfer.dropEffect = "copy";
      blocklyPanel.classList.add("drop-highlight");
    }
  });

  // `dragleave` também borbulha dos descendentes (o SVG do Blockly), então só
  // limpa o destaque quando o ponteiro sai do painel de verdade.
  blocklyDiv.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && blocklyDiv.contains(e.relatedTarget)) return;
    blocklyPanel.classList.remove("drop-highlight");
  });

  // Arraste cancelado (Esc / solto fora) nunca dispara `drop`.
  window.addEventListener("dragend", () => {
    blocklyPanel.classList.remove("drop-highlight");
  });

  blocklyDiv.addEventListener("drop", (e) => {
    if (!isTextDrag(e)) return;
    e.preventDefault();
    blocklyPanel.classList.remove("drop-highlight");

    if (!selectionMode) {
      toast('Ative o "Modo Seleção" na barra superior para criar blocos.');
      return;
    }

    const text = e.dataTransfer.getData("text/plain");
    const rawMeta = e.dataTransfer.getData(DRAG_META_TYPE);
    let drag = null;
    if (rawMeta) {
      try {
        drag = JSON.parse(rawMeta);
      } catch (_) {
        drag = null;
      }
    }
    if (!drag) drag = lastDragMeta;

    const meta = drag ? { color: drag.color, pdfId: drag.pdfId } : null;
    const block = createTextBlockAt(text, e.clientX, e.clientY, meta);

    if (block && drag) {
      const info = openPdfs.get(drag.pdfId);
      for (const m of drag.marks) applyMarks(info, m.pageKey, m.relRects);
    }
  });
}

// ---------------------------------------------------------------
// Marca (tracejado) a área da página de onde um texto foi extraído
// ---------------------------------------------------------------
// Sublinha, na cor do PDF, o trecho que ja foi levado para um bloco.
//
// A cor vem por parametro e e escrita no proprio elemento. Antes o CSS a lia
// por heranca, com `var(--pdf-color, #16a34a)`: bastava a marca ficar fora do
// card que define a variavel para tudo cair no fallback -- verde, em todos os
// PDFs, independentemente da cor de cada um.
// Ponto unico por onde um sublinhado passa: guarda no `info` (fonte do que sera
// salvo) e desenha na pagina. Usado tanto no drop quanto ao reabrir um projeto.
function applyMarks(info, pageKey, rects, registrar = true) {
  if (!info || !rects || !rects.length) return;
  if (registrar) {
    const existente = info.marks.find((m) => m.pageKey === pageKey);
    if (existente) existente.rects.push(...rects);
    else info.marks.push({ pageKey, rects: rects.slice() });
  }
  const pageWrapper = info.cardEl.querySelector(
    `.pdf-page[data-page-key="${CSS.escape(pageKey)}"]`
  );
  if (pageWrapper) markExtraction(pageWrapper, rects, info.color.hex);
}

function markExtraction(pageWrapper, relRects, color) {
  let overlay = pageWrapper.querySelector(":scope > .extraction-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "extraction-overlay";
    pageWrapper.appendChild(overlay);
  }
  for (const r of relRects) {
    const mark = document.createElement("div");
    mark.className = "extraction-mark";
    mark.style.left = r.left + "px";
    mark.style.top = r.top + "px";
    mark.style.width = r.width + "px";
    mark.style.height = r.height + "px";
    if (color) {
      mark.style.setProperty("--mark-color", color);
      const tint = rgbaFromHex(color, 0.12);
      if (tint) mark.style.setProperty("--mark-tint", tint);
    }
    overlay.appendChild(mark);
  }
}

// ---------------------------------------------------------------
// Arraste de seleção do PDF → bloco Blockly
// (Usa o arraste nativo do navegador, que já popula dataTransfer
//  com text/plain quando o usuário arrasta uma seleção de texto.)
// ---------------------------------------------------------------
function initPdfTextDrag() {
  pdfPages.addEventListener("dragstart", (e) => {
    if (!selectionMode) {
      e.preventDefault();
      return;
    }

    // Ao arrastar uma seleção, `e.target` pode ser o nó de texto onde o
    // arraste começou, e nó de texto não tem `closest`: a chamada lançava
    // TypeError, o setData do meta nunca acontecia e o bloco nascia sem cor.
    const alvo =
      e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
    const card = alvo ? alvo.closest(".pdf-card") : null;
    const info = card ? openPdfs.get(card.dataset.pdfId) : null;

    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!info || !text || !sel.rangeCount) {
      e.preventDefault();
      return;
    }

    const meta = {
      pdfId: info.id,
      color: info.color.hex,
      // Os retângulos da seleção (que pode já não ser válida no drop) viajam
      // junto, em coordenadas da página de origem, identificada por uma chave
      // estável (data-page-key).
      marks: collectSelectionMarks(sel, card),
    };

    // O meta vai pelos dois caminhos de propósito. O dataTransfer é o correto,
    // mas basta o navegador descartar o tipo customizado (acontece em alguns
    // arrastes de seleção nativa) para o drop receber só text/plain — e aí o
    // bloco caía na cor padrão do `setColour(160)`, verde, para todos os PDFs.
    // A variável de módulo cobre esse caso; o drop prefere o dataTransfer.
    lastDragMeta = meta;

    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copy";
    try {
      e.dataTransfer.setData(DRAG_META_TYPE, JSON.stringify(meta));
    } catch (err) {
      console.warn("[drag] meta não coube no dataTransfer:", err);
    }
  });

  // `dragend` vem depois do `drop`, então o espelho já cumpriu seu papel aqui.
  pdfPages.addEventListener("dragend", () => {
    lastDragMeta = null;
  });
}

// Retângulos da seleção → coordenadas locais de cada página do card.
//
// A página de cada retângulo é encontrada por geometria, e não por
// document.elementFromPoint: trechos rolados para fora da área visível do card
// não são atingidos por hit-test e ficavam sem marcação.
function collectSelectionMarks(sel, card) {
  const pages = Array.from(card.querySelectorAll(".pdf-page")).map((el) => ({
    key: el.dataset.pageKey,
    rect: el.getBoundingClientRect(),
  }));
  const byPage = new Map(); // pageKey -> relRects[]

  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of sel.getRangeAt(i).getClientRects()) {
      if (r.width === 0 || r.height === 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const page = pages.find(
        (p) =>
          cx >= p.rect.left &&
          cx <= p.rect.right &&
          cy >= p.rect.top &&
          cy <= p.rect.bottom
      );
      if (!page) continue;
      // getBoundingClientRect() já inclui o zoom do canvas; as marcas ficam
      // dentro da página, que é escalada junto — logo precisam ser gravadas
      // sem o zoom, senão saem deslocadas e menores.
      if (!byPage.has(page.key)) byPage.set(page.key, []);
      byPage.get(page.key).push({
        left: (r.left - page.rect.left) / zoomLevel,
        top: (r.top - page.rect.top) / zoomLevel,
        width: r.width / zoomLevel,
        height: r.height / zoomLevel,
      });
    }
  }

  return Array.from(byPage, ([pageKey, rects]) => ({
    pageKey,
    relRects: mergeRects(rects),
  }));
}

// Uma mesma linha rende retângulos quase idênticos (caixa do span + caixa do
// nó de texto); sobrepostos, escureciam a marcação. Funde-os em um só.
function overlapRatio(a, b) {
  const w =
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

function mergeRects(rects) {
  const out = [];
  for (const r of rects) {
    const hit = out.find((o) => overlapRatio(o, r) > 0.6);
    if (!hit) {
      out.push({ ...r });
      continue;
    }
    const right = Math.max(hit.left + hit.width, r.left + r.width);
    const bottom = Math.max(hit.top + hit.height, r.top + r.height);
    hit.left = Math.min(hit.left, r.left);
    hit.top = Math.min(hit.top, r.top);
    hit.width = right - hit.left;
    hit.height = bottom - hit.top;
  }
  return out;
}

// ---------------------------------------------------------------
// Cards de PDF (um por documento aberto)
// ---------------------------------------------------------------
function createPdfCard(id, name, color) {
  const card = document.createElement("div");
  card.className = "pdf-card";
  card.dataset.pdfId = id;
  card.style.setProperty("--pdf-color", color.hex);
  card.style.setProperty("--pdf-color-soft", color.soft);

  const header = document.createElement("div");
  header.className = "pdf-card-header";

  const swatch = document.createElement("span");
  swatch.className = "pdf-color-swatch";

  const title = document.createElement("span");
  title.className = "pdf-card-title";
  title.textContent = name;
  title.title = name;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pdf-card-close";
  closeBtn.setAttribute("aria-label", "Fechar PDF");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => closePdf(id));

  header.append(swatch, title, closeBtn);

  const pagesEl = document.createElement("div");
  pagesEl.className = "pdf-card-pages";

  card.append(header, pagesEl);
  return { card, pagesEl, header };
}

// ---------------------------------------------------------------
// Canvas livre: pan/zoom do painel e arraste dos embeds de PDF
// ---------------------------------------------------------------
function applyCanvasTransform() {
  pdfPages.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
}

function screenToCanvas(clientX, clientY) {
  const rect = pdfPanel.getBoundingClientRect();
  return {
    x: (clientX - rect.left - panX) / zoomLevel,
    y: (clientY - rect.top - panY) / zoomLevel,
  };
}

// Posição do próximo embed: sob o cursor (drop de arquivo) ou em cascata a
// partir do centro do que está visível agora (botão "Abrir PDF").
function nextEmbedPosition(clientX, clientY) {
  const cascade = 28 * (placeCounter++ % 10);
  let base;
  if (typeof clientX === "number") {
    base = screenToCanvas(clientX, clientY);
    base.x -= EMBED_WIDTH / 2;
    base.y -= 24;
  } else {
    const rect = pdfPanel.getBoundingClientRect();
    base = screenToCanvas(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    base.x -= EMBED_WIDTH / 2;
    base.y -= 200;
  }
  return { x: base.x + cascade, y: base.y + cascade };
}

// Os listeners de mousemove/mouseup vivem só durante o arraste: antes eram
// registrados em `window` por card e nunca removidos, acumulando um par a cada
// PDF aberto (e sobrevivendo ao fechamento do card).
function makeCardDraggable(card, header) {
  header.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".pdf-card-close")) return;
    e.preventDefault();

    card.style.zIndex = ++topZ;
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = parseFloat(card.style.left) || 0;
    const origTop = parseFloat(card.style.top) || 0;
    document.body.style.userSelect = "none";

    const onMove = (ev) => {
      card.style.left = origLeft + (ev.clientX - startX) / zoomLevel + "px";
      card.style.top = origTop + (ev.clientY - startY) / zoomLevel + "px";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function initPdfCanvasPan() {
  let panning = false;
  let startX, startY, startPanX, startPanY;

  pdfPanel.addEventListener("mousedown", (e) => {
    if (e.target.closest(".pdf-card")) return; // embed cuida do próprio arraste
    if (e.button !== 0) return;
    panning = true;
    pdfPanel.classList.add("panning");
    startX = e.clientX;
    startY = e.clientY;
    startPanX = panX;
    startPanY = panY;
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (e) => {
    if (!panning) return;
    panX = startPanX + (e.clientX - startX);
    panY = startPanY + (e.clientY - startY);
    applyCanvasTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!panning) return;
    panning = false;
    pdfPanel.classList.remove("panning");
    document.body.style.userSelect = "";
    scheduleResolutionRefresh(); // páginas que entraram na tela
  });
}

function initPdfCanvasWheel() {
  pdfPanel.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = pdfPanel.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const prevZoom = zoomLevel;
        zoomLevel = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, zoomLevel * (e.deltaY < 0 ? 1.1 : 0.9))
        );
        panX = cx - (cx - panX) * (zoomLevel / prevZoom);
        panY = cy - (cy - panY) * (zoomLevel / prevZoom);
        applyCanvasTransform();
        scheduleResolutionRefresh();
        return;
      }

      // Sem ctrl a roda desloca o canvas (shift = horizontal). O painel tem
      // overflow:hidden, então antes o scroll simplesmente não fazia nada.
      // Dentro de um card que ainda pode rolar, o scroll nativo tem prioridade.
      const scroller = e.target.closest && e.target.closest(".pdf-card-pages");
      if (scroller && scroller.scrollHeight > scroller.clientHeight) return;

      e.preventDefault();
      if (e.shiftKey) {
        panX -= e.deltaY;
      } else {
        panX -= e.deltaX;
        panY -= e.deltaY;
      }
      applyCanvasTransform();
      scheduleResolutionRefresh();
    },
    { passive: false }
  );
}

function closePdf(id, silent) {
  const info = openPdfs.get(id);
  if (!info) return;
  info.closed = true; // interrompe o laço de renderização em loadPdf()
  info.cardEl.remove();
  try {
    info.pdfDoc.destroy();
  } catch (_) {
    /* ignore */
  }
  openPdfs.delete(id);
  if (openPdfs.size === 0) pdfPlaceholder.style.display = "";
  if (!silent) toast(`PDF removido: ${info.name}`);
}

// ---------------------------------------------------------------
// Carregamento e renderização de PDFs (múltiplos, um card por PDF)
// ---------------------------------------------------------------
// `restore` vem do "Abrir Projeto": traz o id, a cor e a posicao originais, para
// que o projeto reabra identico. O id precisa ser o mesmo porque os blocos
// referenciam o PDF de origem por ele, e as chaves das paginas (`data-page-key`,
// usadas para reancorar os sublinhados) sao derivadas dele.
async function loadPdf(arrayBuffer, fileName, opts = {}) {
  const { dropPos = null, restore = null, fileKey = null } = opts;
  if (!LIB_PDFJS) {
    toast("PDF.js não carregou (sem internet?). Recarregue a página.");
    return null;
  }

  // O pdf.js transfere o ArrayBuffer para o worker e o deixa destacado (byteLength
  // 0). A copia e feita antes, senao nao haveria mais bytes para salvar no projeto.
  const bytes = new Uint8Array(arrayBuffer.slice(0));

  let pdfDoc;
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    console.error(err);
    toast(`Não foi possível abrir "${fileName}".`);
    return null;
  }

  const id = restore ? restore.id : "pdf-" + ++pdfIdSeq;
  const color = restore ? restore.color : nextPdfColor();
  const { card, pagesEl, header } = createPdfCard(id, fileName, color);

  if (restore) {
    card.style.left = restore.left + "px";
    card.style.top = restore.top + "px";
    card.style.zIndex = restore.z;
    topZ = Math.max(topZ, restore.z);
  } else {
    const pos = dropPos
      ? nextEmbedPosition(dropPos.x, dropPos.y)
      : nextEmbedPosition();
    card.style.left = pos.x + "px";
    card.style.top = pos.y + "px";
    card.style.zIndex = ++topZ;
  }

  pdfPages.appendChild(card);
  pdfPlaceholder.style.display = "none";
  makeCardDraggable(card, header);
  card.addEventListener("mousedown", () => {
    card.style.zIndex = ++topZ;
  });

  const info = {
    id,
    name: fileName,
    color,
    pdfDoc,
    bytes,
    // Chave do cracha de acesso, quando o arquivo veio pelo picker. Vai no
    // projeto leve para permitir religar sem procurar o arquivo de novo.
    fileKey: fileKey || (restore ? restore.fileKey : null) || null,
    cardEl: card,
    pagesEl,
    pages: [],
    // Sublinhados ja aplicados, por pagina. Ficam aqui, e nao so no DOM, porque
    // e daqui que "Salvar Projeto" os le.
    marks: [],
    closed: false,
  };
  openPdfs.set(id, info);

  // Páginas reveladas ao rolar o card também precisam ganhar resolução.
  pagesEl.addEventListener("scroll", scheduleResolutionRefresh, { passive: true });

  const availWidth = EMBED_WIDTH - 24; // largura fixa do embed, não do painel

  // Fechar o card destrói o documento; sem estas checagens as páginas
  // pendentes seguiam renderizando e a promise estourava com
  // "Transport destroyed" — rejeição não tratada no console.
  try {
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      if (info.closed) return null;
      const page = await pdfDoc.getPage(n);
      if (info.closed) return null;
      await renderPage(page, n, availWidth, pagesEl, id, info);
    }
  } catch (err) {
    if (info.closed) return null; // erro esperado: documento destruído no meio
    console.error(err);
    toast(`Falha ao renderizar "${fileName}".`);
    return null;
  }

  // Só agora as páginas existem no DOM e os sublinhados têm onde ancorar.
  if (restore) {
    for (const m of restore.marks || []) {
      applyMarks(info, m.pageKey, m.rects);
    }
    if (restore.scrollTop) pagesEl.scrollTop = restore.scrollTop;
    return info;
  }

  toast(`PDF carregado: ${fileName} (${pdfDoc.numPages} página(s)).`);
  return info;
}

// Resolução de bitmap desejada para o zoom atual do canvas. O <canvas> tem
// tamanho CSS fixo e é esticado pelo transform do painel: sem redesenhar, o
// bitmap é ampliado e o texto sai borrado.
function targetRenderScale() {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(MAX_RENDER_SCALE, Math.max(1, dpr * zoomLevel));
}

async function renderPage(page, pageNumber, availWidth, container, pdfId, info) {
  const baseViewport = page.getViewport({ scale: 1 });
  let scale = availWidth / baseViewport.width;
  scale = Math.min(3, Math.max(0.4, scale));
  const viewport = page.getViewport({ scale });

  const label = document.createElement("div");
  label.className = "page-number";
  label.textContent = "Página " + pageNumber;
  container.appendChild(label);

  const wrapper = document.createElement("div");
  wrapper.className = "pdf-page";
  wrapper.dataset.pageKey = pdfId + "-" + pageNumber;
  container.appendChild(wrapper);

  const renderScale = targetRenderScale();
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * renderScale);
  canvas.height = Math.floor(viewport.height * renderScale);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";
  wrapper.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const renderTask = page.render({
    canvasContext: ctx,
    viewport: viewport,
    transform: [renderScale, 0, 0, renderScale, 0, 0],
  });

  // Camada de texto selecionável/arrastável
  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  textLayerDiv.style.setProperty("--scale-factor", scale);
  wrapper.appendChild(textLayerDiv);

  const textContent = await page.getTextContent();
  const textTask = pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport: viewport,
  });

  await Promise.all([renderTask.promise, textTask.promise]);

  // Guardado para poder redesenhar a página em outra resolução ao dar zoom.
  if (info) {
    info.pages.push({
      page,
      wrapper,
      canvas,
      baseScale: scale,
      renderScale,
      pendingScale: renderScale,
      task: null,
    });
    // A página pode ter terminado depois de um zoom: garante que ela alcance
    // a resolução atual em vez de ficar na que valia quando começou.
    scheduleResolutionRefresh();
  }
}

// Redesenha o bitmap da página na resolução pedida, sem piscar: o desenho vai
// para um canvas solto e só substitui o antigo quando termina.
async function rerenderPageCanvas(entry, renderScale) {
  // Esta resolução já está pronta ou a caminho. Sem esta reserva — feita
  // antes de qualquer await — pedidos seguidos de zoom cancelavam uns aos
  // outros indefinidamente e a página nunca chegava a ficar nítida.
  if (entry.pendingScale === renderScale) return;
  entry.pendingScale = renderScale;

  // O pdf.js não aceita dois desenhos simultâneos da mesma página: cancela o
  // anterior e espera ele de fato terminar antes de começar o novo.
  if (entry.task) {
    try {
      entry.task.cancel();
    } catch (_) {
      /* ignore */
    }
    try {
      await entry.task.promise;
    } catch (_) {
      /* cancelamento é o caminho esperado */
    }
    entry.task = null;
  }

  const viewport = entry.page.getViewport({ scale: entry.baseScale });
  const next = document.createElement("canvas");
  next.width = Math.floor(viewport.width * renderScale);
  next.height = Math.floor(viewport.height * renderScale);
  next.style.width = Math.floor(viewport.width) + "px";
  next.style.height = Math.floor(viewport.height) + "px";

  const task = entry.page.render({
    canvasContext: next.getContext("2d"),
    viewport,
    transform: [renderScale, 0, 0, renderScale, 0, 0],
  });
  entry.task = task;

  try {
    await task.promise;
  } catch (_) {
    // Cancelado por um zoom mais novo, ou documento fechado. Libera a reserva
    // só se ninguém mais assumiu, para não travar tentativas futuras.
    if (entry.pendingScale === renderScale) entry.pendingScale = entry.renderScale;
    return;
  }
  if (entry.task !== task) return; // já foi superado por outro pedido
  entry.task = null;
  entry.canvas.replaceWith(next);
  entry.canvas = next;
  entry.renderScale = renderScale;
  entry.pendingScale = renderScale;
}

// Só redesenha páginas visíveis: com vários PDFs abertos, redesenhar tudo a
// cada passo do zoom travaria a interface.
let resolutionTimer = null;
function scheduleResolutionRefresh() {
  clearTimeout(resolutionTimer);
  resolutionTimer = setTimeout(refreshPdfResolution, 180);
}

function refreshPdfResolution() {
  const target = targetRenderScale();
  const panelRect = pdfPanel.getBoundingClientRect();

  for (const info of openPdfs.values()) {
    if (info.closed) continue;
    for (const entry of info.pages) {
      // Margem morta: evita redesenhar a cada clique da roda do mouse. Compara
      // com o desenho em andamento, se houver, para não enfileirar trabalho
      // repetido enquanto ele não termina.
      const atual = entry.pendingScale || entry.renderScale;
      if (target <= atual * 1.1 && target >= atual * 0.6) continue;
      const r = entry.wrapper.getBoundingClientRect();
      const visivel =
        r.bottom > panelRect.top &&
        r.top < panelRect.bottom &&
        r.right > panelRect.left &&
        r.left < panelRect.right;
      if (!visivel) continue;
      rerenderPageCanvas(entry, target);
    }
  }
}

function handlePdfFile(file, dropPos, fileKey) {
  if (!file) return;
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    toast("Por favor, envie um arquivo PDF.");
    return;
  }
  file
    .arrayBuffer()
    .then((buf) => loadPdf(buf, file.name, { dropPos, fileKey }))
    .catch((err) => {
      console.error(err);
      toast(`Não foi possível ler "${file.name}".`);
    });
}

// Caminho normal do botao "Abrir PDF". Prefere o picker do File System Access
// porque so ele devolve um handle -- o cracha que permite religar o PDF quando
// um projeto leve for reaberto. Sem a API (ou se ela falhar), cai no <input
// type=file> de sempre, e o projeto leve pedira os arquivos na mao.
async function abrirPdfs() {
  if (TEM_FS_API) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (err) {
      if (err && err.name === "AbortError") return; // usuário fechou o seletor
      console.warn("[abrir] picker indisponível, usando o input:", err);
      $("#pdfFileInput").click();
      return;
    }
    for (const handle of handles) {
      try {
        const file = await handle.getFile();
        const key = fileKeyOf(file);
        await idbSet(key, handle);
        handlePdfFile(file, null, key);
      } catch (err) {
        console.error("[abrir] falha ao ler o arquivo escolhido:", err);
        toast("Não foi possível ler um dos arquivos escolhidos.");
      }
    }
    return;
  }
  $("#pdfFileInput").click();
}

function initPdfDrop() {
  pdfPanel.addEventListener("dragover", (e) => {
    const types = Array.from(e.dataTransfer ? e.dataTransfer.types : []);
    if (!types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    pdfPanel.classList.add("dragover");
  });

  pdfPanel.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && pdfPanel.contains(e.relatedTarget)) return;
    pdfPanel.classList.remove("dragover");
  });

  pdfPanel.addEventListener("drop", (e) => {
    const types = Array.from(e.dataTransfer ? e.dataTransfer.types : []);
    if (!types.includes("Files")) return;
    e.preventDefault();
    pdfPanel.classList.remove("dragover");
    const pos = { x: e.clientX, y: e.clientY };
    Array.from(e.dataTransfer.files).forEach((f) => handlePdfFile(f, pos));
  });
}

// ---------------------------------------------------------------
// Impede o navegador de "abrir" arquivos soltos fora do painel
// ---------------------------------------------------------------
function initGlobalFileGuard() {
  const guard = (e) => {
    const types = Array.from(e.dataTransfer ? e.dataTransfer.types : []);
    if (types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", guard);
  window.addEventListener("drop", guard);
}

// ---------------------------------------------------------------
// Modo seleção (toggle)
// ---------------------------------------------------------------
function setSelectionMode(on) {
  selectionMode = on;
  document.body.classList.toggle("selection-mode", on);
  btnSelectMode.classList.toggle("active", on);
  btnSelectMode.setAttribute("aria-pressed", String(on));
  btnSelectMode.textContent = on ? "Modo Seleção: ON" : "Modo Seleção: OFF";
  if (on) {
    toast("Modo Seleção ativo: selecione texto no PDF e arraste para o painel de blocos.");
  }
}

// ---------------------------------------------------------------
// Exportar texto montado (blocos de cima para baixo)
// ---------------------------------------------------------------
// Separador padrão entre dois trechos e entre duas pilhas: uma linha em
// branco, ou seja, parágrafo novo.
const PARAGRAFO = "\n\n";

// Monta uma pilha inteira, de cima para baixo. Marcadores que não escrevem
// nada (cabeçalho, nota) simplesmente não contribuem.
function montarPilha(topo) {
  const partes = [];
  let extra = null; // linhas em branco pedidas por um ⏎ ainda não gasto

  for (let b = topo; b; b = b.getNextBlock()) {
    let trecho;
    switch (b.type) {
      case "pdf_text":
        trecho = (b.getFieldValue("TEXT") || "").trim();
        break;
      case "txt_separador":
        trecho = (b.getFieldValue("LINHA") || "").trim();
        break;
      case "txt_espaco":
        extra = Number(b.getFieldValue("QTD")) || 1;
        continue;
      default: // txt_pilha, txt_nota e qualquer marcador futuro mudo
        continue;
    }

    if (!trecho) continue;
    if (partes.length) partes.push(extra ? "\n".repeat(extra + 1) : PARAGRAFO);
    partes.push(trecho);
    extra = null;
  }

  return partes.join("");
}

function exportText() {
  if (!workspace) return;

  // Pilha por pilha, na ordem de leitura — a mesma que os selos mostram na
  // tela. Achatar tudo e ordenar por posição intercalava pilhas lado a lado.
  const pilhas = pilhasNaOrdem();
  const textos = [];
  for (const p of pilhas) {
    const t = montarPilha(p.block);
    if (t) textos.push(t);
  }

  if (!textos.length) {
    toast("Nenhum texto para exportar.");
    return;
  }

  const text = textos.join(PARAGRAFO);

  downloadBlob(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
    "texto-blocos.txt"
  );
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  toast(
    textos.length === 1
      ? "Texto exportado (arquivo .txt + área de transferência)."
      : `Texto exportado: ${textos.length} pilhas na ordem dos selos.`
  );
}

// ---------------------------------------------------------------
// Salvar / carregar projeto
// ---------------------------------------------------------------
// Os bytes do PDF vao dentro do proprio .json, em base64. E o que permite
// reabrir o projeto identico sem depender de os arquivos originais ainda
// estarem no mesmo lugar do disco -- ao custo de um .json grande (base64
// cresce ~33% sobre o tamanho somado dos PDFs).
const PROJECT_FORMAT = "blocky-pdf-editor";
const PROJECT_VERSION = 3;

function bytesToBase64(bytes) {
  // Em pedaços: `String.fromCharCode(...bytes)` de uma vez estoura a pilha
  // em PDFs de poucos MB.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Separado do download para poder ser exercitado sozinho (e porque salvar e
// entregar o arquivo sao duas responsabilidades distintas).
// `embed` decide entre os dois formatos. Sem ele o projeto guarda apenas a
// referencia de cada PDF (nome, cor, posicao, sublinhados) e fica na casa dos
// KB; o texto extraido ja vive nos blocos, entao nada do trabalho se perde --
// o que falta e so a imagem de referencia do painel esquerdo.
function buildProject(embed) {
  const pdfs = [];
  for (const info of openPdfs.values()) {
    if (info.closed) continue;
    const p = {
      id: info.id,
      name: info.name,
      color: info.color,
      fileKey: info.fileKey,
      left: parseFloat(info.cardEl.style.left) || 0,
      top: parseFloat(info.cardEl.style.top) || 0,
      z: parseInt(info.cardEl.style.zIndex, 10) || 1,
      scrollTop: info.pagesEl.scrollTop,
      marks: info.marks,
    };
    if (embed) p.data = bytesToBase64(info.bytes);
    pdfs.push(p);
  }

  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    embedded: !!embed,
    canvas: { panX, panY, zoom: zoomLevel },
    pdfs,
    blocks: Blockly.serialization.workspaces.save(workspace),
  };
}

function gravarProjeto(embed) {
  const projeto = buildProject(embed);
  const blob = new Blob([JSON.stringify(projeto)], {
    type: "application/json;charset=utf-8",
  });
  downloadBlob(
    blob,
    embed ? "projeto-blocos-com-pdfs.json" : "projeto-blocos.json"
  );

  const n = projeto.pdfs.length;
  const tamanho =
    blob.size < 1024 * 1024
      ? `${Math.max(1, Math.round(blob.size / 1024))} KB`
      : `${(blob.size / (1024 * 1024)).toFixed(1)} MB`;
  toast(
    embed
      ? `Projeto salvo com ${n} PDF(s) embutido(s): ${tamanho}.`
      : `Projeto salvo (${tamanho}). Os ${n} PDF(s) são religados ao abrir.`
  );
}

function saveProject() {
  gravarProjeto(false);
}

function saveProjectWithPdfs() {
  gravarProjeto(true);
}

async function loadProject(file) {
  if (!file) return;

  let projeto;
  try {
    projeto = JSON.parse(await file.text());
  } catch (err) {
    console.error(err);
    toast("Arquivo de projeto inválido.");
    return;
  }

  // Projetos antigos eram o estado cru do Blockly, sem `format`: mantidos
  // legiveis, so nao trazem PDFs para restaurar.
  const novo = projeto && projeto.format === PROJECT_FORMAT;
  const blocos = novo ? projeto.blocks : projeto;

  esconderBarraReligacao();
  for (const id of Array.from(openPdfs.keys())) closePdf(id, true);

  try {
    workspace.clear();
    if (blocos) Blockly.serialization.workspaces.load(blocos, workspace);
    // `loadExtraState` roda antes de o bloco ter SVG, entao o tom e aplicado
    // aqui, com o workspace ja renderizado.
    workspace.getAllBlocks(false).forEach(applyPdfTint);
    agendarRevalidacao();
  } catch (err) {
    console.error(err);
    toast("Não foi possível carregar os blocos do projeto.");
    return;
  }

  if (!novo) {
    toast("Projeto carregado (formato antigo, sem PDFs).");
    return;
  }

  if (projeto.canvas) {
    panX = projeto.canvas.panX || 0;
    panY = projeto.canvas.panY || 0;
    zoomLevel = projeto.canvas.zoom || 1;
    applyCanvasTransform();
  }

  const lista = projeto.pdfs || [];

  // Ids e cores dos proximos PDFs abertos nao podem colidir com os restaurados.
  // Feito antes de qualquer await: um PDF aberto durante a restauracao ja pega
  // a numeracao correta.
  for (const p of lista) {
    const n = parseInt(String(p.id).replace("pdf-", ""), 10);
    if (Number.isFinite(n)) pdfIdSeq = Math.max(pdfIdSeq, n);
    const i = PDF_COLOR_PALETTE.findIndex((c) => c.hex === (p.color && p.color.hex));
    if (i >= 0) paletteIndex = Math.max(paletteIndex, i + 1);
  }

  // Os que trazem os bytes voltam agora; os demais dependem do disco.
  const pendentes = [];
  let falhas = 0;
  for (const p of lista) {
    if (!p.data) {
      pendentes.push(p);
      continue;
    }
    try {
      const bytes = base64ToBytes(p.data);
      if (!(await loadPdf(bytes.buffer, p.name, { restore: p }))) falhas++;
    } catch (err) {
      console.error(`[projeto] falha ao restaurar "${p.name}":`, err);
      falhas++;
    }
  }

  if (falhas) toast(`${falhas} PDF(s) do projeto não puderam ser abertos.`);

  if (pendentes.length) {
    await oferecerReligacao(pendentes);
  } else if (!falhas) {
    toast(`Projeto carregado: ${lista.length} PDF(s).`);
  }
}

// ---------------------------------------------------------------
// Religacao dos PDFs de um projeto leve
// ---------------------------------------------------------------

// Restaura um PDF a partir de um File ja em maos.
async function restaurarPdf(p, file) {
  const buf = await file.arrayBuffer();
  return loadPdf(buf, p.name, { restore: p });
}

// Quais pendentes tem cracha de acesso valido neste navegador. `queryPermission`
// nao pede nada ao usuario: so informa se a autorizacao ainda vale.
async function comCrachaDisponivel(pendentes) {
  if (!TEM_FS_API) return [];
  const achados = [];
  for (const p of pendentes) {
    if (!p.fileKey) continue;
    const handle = await idbGet(p.fileKey);
    if (handle) achados.push({ p, handle });
  }
  return achados;
}

async function oferecerReligacao(pendentes) {
  const comCracha = await comCrachaDisponivel(pendentes);
  const nomes = pendentes.map((p) => p.name).join(", ");

  if (comCracha.length === pendentes.length && comCracha.length > 0) {
    // Caminho do "um clique": requestPermission exige um gesto do usuario, e o
    // clique no botao da barra e esse gesto.
    mostrarBarraReligacao({
      texto: `Este projeto usa ${pendentes.length} PDF(s): ${nomes}.`,
      rotulo: "Restaurar PDFs",
      acao: async () => {
        let ok = 0;
        for (const { p, handle } of comCracha) {
          try {
            let perm = await handle.queryPermission({ mode: "read" });
            if (perm !== "granted") {
              perm = await handle.requestPermission({ mode: "read" });
            }
            if (perm !== "granted") continue;
            if (await restaurarPdf(p, await handle.getFile())) ok++;
          } catch (err) {
            console.warn(`[religar] "${p.name}" falhou:`, err);
          }
        }
        if (ok === pendentes.length) {
          toast(`${ok} PDF(s) restaurado(s).`);
        } else {
          // Arquivo movido, renomeado ou permissao negada: sobra o seletor.
          toast("Não deu para restaurar tudo. Selecione os arquivos.");
          await oferecerSelecaoManual(pendentes.filter((p) => !openPdfs.has(p.id)));
        }
      },
    });
    return;
  }

  await oferecerSelecaoManual(pendentes);
}

// Sem cracha (outro computador, outro navegador, arquivo trocado): o usuario
// aponta os arquivos e o casamento e feito pelo nome.
function oferecerSelecaoManual(pendentes) {
  if (!pendentes.length) return Promise.resolve();
  const nomes = pendentes.map((p) => p.name).join(", ");
  mostrarBarraReligacao({
    texto: `Este projeto usa ${pendentes.length} PDF(s): ${nomes}.`,
    rotulo: "Selecionar arquivos",
    acao: async () => {
      const arquivos = await escolherArquivos();
      if (!arquivos.length) return;

      const porNome = new Map();
      for (const f of arquivos) porNome.set(f.name, f);

      let ok = 0;
      for (const p of pendentes) {
        const f = porNome.get(p.name);
        if (!f) continue;
        try {
          if (await restaurarPdf(p, f)) ok++;
        } catch (err) {
          console.error(`[religar] "${p.name}" falhou:`, err);
        }
      }

      const faltando = pendentes.filter((p) => !openPdfs.has(p.id));
      if (faltando.length) {
        toast(`Faltou: ${faltando.map((p) => p.name).join(", ")}.`);
        oferecerSelecaoManual(faltando);
      } else {
        toast(`${ok} PDF(s) restaurado(s).`);
      }
    },
  });
  return Promise.resolve();
}

// Escolhe arquivos e, quando da, ja guarda o cracha para a proxima vez.
async function escolherArquivos() {
  if (TEM_FS_API) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
      const arquivos = [];
      for (const h of handles) {
        const f = await h.getFile();
        await idbSet(fileKeyOf(f), h);
        arquivos.push(f);
      }
      return arquivos;
    } catch (err) {
      if (err && err.name === "AbortError") return [];
      console.warn("[religar] picker indisponível, usando o input:", err);
    }
  }

  // Fallback: um <input type=file> descartavel, resolvido pelo evento.
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.addEventListener("change", () => resolve(Array.from(input.files)));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

function mostrarBarraReligacao({ texto, rotulo, acao }) {
  const bar = $("#relink-bar");
  const btn = $("#relink-action");
  $("#relink-text").textContent = texto;
  btn.textContent = rotulo;

  // O listener e trocado a cada oferta; clonar o botao descarta o anterior sem
  // precisar guardar referencia para removeEventListener.
  const novo = btn.cloneNode(true);
  // A oferta seguinte e montada de dentro do handler da anterior, com o botao
  // ainda desabilitado; sem isto o clone nascia travado e a barra virava
  // enfeite na segunda rodada.
  novo.disabled = false;
  btn.replaceWith(novo);
  novo.addEventListener("click", async () => {
    novo.disabled = true;
    // A barra sai de cena antes da ação; se ainda faltar algum PDF, a própria
    // ação a reexibe com a lista reduzida.
    esconderBarraReligacao();
    try {
      await acao();
    } catch (err) {
      console.error("[religar] ação falhou:", err);
      toast("Não foi possível restaurar os PDFs.");
    } finally {
      novo.disabled = false;
    }
  });

  bar.hidden = false;
}

function esconderBarraReligacao() {
  $("#relink-bar").hidden = true;
}

// ---------------------------------------------------------------
// Splitter (redimensionar painéis)
// ---------------------------------------------------------------
function initSplitter() {
  const splitter = $("#splitter");
  const main = $("#main");
  let dragging = false;

  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    splitter.classList.add("dragging");
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(80, Math.max(20, pct));
    pdfPanel.style.flexBasis = pct + "%";
    if (workspace) Blockly.svgResize(workspace);
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.body.style.userSelect = "";
    if (workspace) Blockly.svgResize(workspace);
  });
}

// ---------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------
function initToolbar() {
  const pdfFileInput = $("#pdfFileInput");
  const projectFileInput = $("#projectFileInput");

  $("#btnOpenPdf").addEventListener("click", abrirPdfs);
  pdfFileInput.addEventListener("change", () => {
    Array.from(pdfFileInput.files).forEach((f) => handlePdfFile(f));
    pdfFileInput.value = "";
  });

  btnSelectMode.addEventListener("click", () =>
    setSelectionMode(!selectionMode)
  );

  $("#btnExport").addEventListener("click", exportText);
  initGuia();
  $("#relink-skip").addEventListener("click", esconderBarraReligacao);

  $("#btnSave").addEventListener("click", saveProject);
  $("#btnSaveFull").addEventListener("click", saveProjectWithPdfs);

  $("#btnLoad").addEventListener("click", () => projectFileInput.click());
  projectFileInput.addEventListener("change", () => {
    loadProject(projectFileInput.files[0]);
    projectFileInput.value = "";
  });
}

// ---------------------------------------------------------------
// Guia
// ---------------------------------------------------------------
function initGuia() {
  const overlay = $("#guia-overlay");
  const btn = $("#btnGuia");
  if (!overlay || !btn) return;

  const fechar = () => {
    overlay.hidden = true;
  };

  btn.addEventListener("click", () => {
    overlay.hidden = false;
    $("#guia-corpo").scrollTop = 0;
  });
  $("#guia-fechar").addEventListener("click", fechar);
  // Clique no fundo escuro fecha; clique dentro do painel, não.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) fechar();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) fechar();
  });
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
// Faixa fixa no topo para falhas que o usuário precisa ver: um toast some em
// 2,4 s e não serve para "a aplicação subiu quebrada".
function showBootError(msg) {
  let bar = document.querySelector("#boot-error");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "boot-error";
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
}

// Cada passo é isolado: antes bastava um deles lançar (tipicamente o Blockly,
// quando o CDN não respondia) para os passos seguintes nunca rodarem. Como o
// `initToolbar` era o penúltimo, o botão "Abrir PDF" ficava sem listener e o
// clique não fazia absolutamente nada. A toolbar agora vem primeiro e nenhuma
// falha derruba o resto.
function bootStep(nome, fn) {
  try {
    fn();
    return true;
  } catch (err) {
    console.error(`[boot] falha em ${nome}:`, err);
    return false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const faltando = [];
  if (!LIB_PDFJS) faltando.push("PDF.js");
  if (!LIB_BLOCKLY) faltando.push("Blockly");
  if (faltando.length) {
    showBootError(
      `Não foi possível carregar ${faltando.join(" e ")} (CDN). ` +
        "Verifique a conexão com a internet e recarregue a página."
    );
  }

  const falhas = [];
  const passo = (nome, fn) => {
    if (!bootStep(nome, fn)) falhas.push(nome);
  };

  // Toolbar primeiro: é o mínimo que precisa funcionar sempre.
  passo("toolbar", initToolbar);
  passo("splitter", initSplitter);
  passo("guarda de arquivos", initGlobalFileGuard);
  passo("drop de PDF", initPdfDrop);
  passo("arraste de texto", initPdfTextDrag);
  passo("pan do canvas", initPdfCanvasPan);
  passo("zoom do canvas", initPdfCanvasWheel);
  passo("canvas", applyCanvasTransform);
  if (LIB_BLOCKLY) {
    passo("Blockly", initBlockly);
    passo("drop no Blockly", initBlocklyDrop);
    passo("divisão por duplo clique", initDivisaoPorDuploClique);
  }

  if (falhas.length && !faltando.length) {
    showBootError(`Falha ao iniciar: ${falhas.join(", ")}. Veja o console (F12).`);
  }
});
