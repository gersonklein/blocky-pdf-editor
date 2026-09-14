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
4. **Bloco `pdf_text`** — Tipo *statement* (conexões anterior/próxima) → empilha verticalmente (mover pra cima/baixo); campo `FieldMultilineInput` editável; deletar via lixeira/menu de contexto; duplicar via menu de contexto; toolbox com bloco vazio para criar do zero; UI em pt-br, lixeira, zoom e scroll.
5. **Exportar texto** — Percorre a pilha de blocos de cima pra baixo → concatena textos (separados por linha em branco) → baixa `.txt` e copia pro clipboard.
6. **Salvar/Carregar** — `Blockly.serialization.workspaces.save/load` → `.json`.

## Verificação

Servir com servidor local (`python -m http.server` ou similar) → testar: carregar PDF, ativar modo seleção, arrastar trecho → bloco criado; mover/deletar/editar/duplicar; exportar; salvar e recarregar projeto.
