# Plano: Editor de Texto por Blocos (PDF → Blockly)

## Objetivo

Web app onde o usuário arrasta um PDF para um canvas (visualizador), ativa o **modo seleção** (cursor muda para ícone de arraste), seleciona uma porção de texto e a arrasta para o workspace do **Google Blockly**. O texto vira um **bloco** — a partir daí funciona como um **editor de texto por blocos**: mover pra cima/baixo, deletar, duplicar, editar conteúdo e criar novos blocos.

## Decisões (aprovadas pelo usuário)

- **Plataforma:** Web app simples (HTML/CSS/JS estático, sem build, dependências via CDN)
- **Interação:** Arraste nativo da seleção de texto do PDF até o workspace Blockly — bloco nasce na posição onde foi solto
- **Extras:** Editar texto dentro do bloco · Exportar texto montado (.txt) · Salvar/carregar projeto (.json)

## Arquitetura

```
_____blocky editor/
├── index.html   → layout: toolbar + painel PDF + painel Blockly
├── style.css    → estilos, cursor do modo seleção, drop zone
├── app.js       → lógica (PDF.js, Blockly, DnD, export/save)
└── PLANO.md     → este arquivo
```

**Dependências via CDN:**
- **PDF.js 3.11** (cdnjs) — renderização do PDF (canvas + textLayer selecionável)
- **Google Blockly** (unpkg) + locale **pt-br** — workspace de blocos

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ [Abrir PDF] [Modo Seleção] [Exportar] [Salvar] [Abrir]   │  toolbar
├────────────────────────────┬─────────────────────────────┤
│  PDF VIEWER                │  BLOCKLY WORKSPACE          │
│  (drop zone p/ arquivo     │  (blocos de texto: mover,   │
│  PDF, scroll contínuo de   │  deletar, duplicar,         │
│  páginas, texto            │  editar, criar novos)       │
│  selecionável/arrastável)  │                             │
└────────────────────────────┴─────────────────────────────┘
```

## Fluxos

1. **Carregar PDF** — Arrastar `.pdf` sobre o painel esquerdo (ou botão) → `arrayBuffer()` → PDF.js renderiza cada página: `<canvas>` (imagem) + `textLayer` (spans selecionáveis) sobrepostos. Scroll contínuo entre páginas.
2. **Modo Seleção** — Botão toggle: cursor vira ícone de drag (`grab`) sobre o texto do PDF, destaque visual na toolbar; drop no Blockly só é aceito com o modo ativo.
3. **Arrastar texto → bloco** — Seleção de texto inicia arraste nativo (`dataTransfer` `text/plain`); handlers `dragover`/`drop` no div do Blockly convertem coordenadas de tela para workspace (`Blockly.utils.screenToWsCoordinates`) e criam o bloco onde foi solto.
4. **Bloco `pdf_text`** — Tipo *statement* (conexões anterior/próxima) → empilha verticalmente (mover pra cima/baixo); campo `FieldMultilineInput` editável; deletar via lixeira/menu de contexto; duplicar via menu de contexto; toolbox com bloco vazio para criar do zero; UI em pt-br, lixeira, zoom e scroll. **Dividir** com dois cliques na borda do bloco, entre as linhas mais próximas do clique (`initDivisaoPorDuploClique()` → `splitTextBlock()`; `Ctrl+Enter` corta no cursor); **grifo** por trecho pela paleta que acompanha o editor (`mostrarPaletaMarcas()`, ou `Alt+1..4`/`Alt+0`; offsets no texto cru em `block.marcas`, desenhados por `desenharMarcas_()`) e **cor do bloco** na mesma paleta (`block.corBloco`). Marcas e cor vão no `extraState`, não no `.txt`.
5. **Marcadores** — Blocos da categoria *Marcadores* que entram na pilha como qualquer outro, mas não carregam texto do PDF: só influenciam a montagem do arquivo. Ver seção abaixo.
6. **Exportar texto** — Percorre **pilha por pilha**, na ordem de leitura, cada uma de cima pra baixo → concatena (linha em branco entre trechos e entre pilhas) → baixa `.txt` e copia pro clipboard.
7. **Salvar/Carregar** — `Blockly.serialization.workspaces.save/load` → `.json`. Marcadores entram na serialização sem tratamento especial.
8. **Guia** — Botão *Guia* na toolbar abre um painel explicando a regra de montagem, os marcadores e os avisos. É a documentação de uso; este arquivo é a de arquitetura.

## Marcadores e ordem de leitura

**Regra de montagem.** Cada bloco de texto vira um parágrafo. Uma pilha é lida inteira, de cima para baixo; pilhas nunca se intercalam. Entre pilhas, também uma linha em branco.

**Ordem entre pilhas** (`pilhasNaOrdem()`): `workspace.getTopBlocks(true)` ordena quase só por Y — o eixo é inclinado em apenas 3° —, então duas pilhas lado a lado saem na ordem de quem tem o topo mais alto, não na ordem das colunas. Por isso a ordem é calculada no app: **coluna a coluna** da esquerda para a direita (colunas ancoradas no X da primeira pilha, com tolerância de 260px ≈ ¾ de bloco) e, dentro de cada coluna, de cima para baixo. Um `txt_pilha` com número tem precedência sobre a geometria; numeradas primeiro, soltas depois.

**Os marcadores.** A aparência é definida em `defineMarcadores()`; o efeito, no `switch` de `montarPilha()` — um marcador novo é sempre esses dois pontos.

| Tipo | Efeito na exportação |
|---|---|
| `txt_pilha` | Nada. Fixa a posição da pilha na ordem de leitura. Sem `previousStatement`, então o Blockly já impede encaixá-lo fora do topo. |
| `txt_separador` | Escreve o conteúdo do campo como um trecho comum. |
| `txt_espaco` | Aumenta o número de linhas em branco antes do próximo trecho. |
| `txt_nota` | Nada, nunca. |

**Selo de ordem.** Com mais de uma pilha, `aplicarSelo()` pendura um `<g>` no SVG do bloco de topo com o número de leitura — acompanha arraste e zoom sem listener de viewport e some junto com o bloco.

**Validação.** `revalidarWorkspace()` marca com `setWarningText` o que não vai sair no `.txt` (bloco vazio, separador vazio, espaço na ponta, pilha sem texto, número repetido). É agendada com `setTimeout` e não `requestAnimationFrame`: rAF não dispara em aba oculta e deixaria a flag de agendamento presa, engolindo todas as revalidações seguintes.

## Verificação

Servir com servidor local (`python -m http.server` ou similar) → testar: carregar PDF, ativar modo seleção, arrastar trecho → bloco criado; mover/deletar/editar/duplicar; exportar; salvar e recarregar projeto.
