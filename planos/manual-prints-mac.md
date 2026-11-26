# Plano: refazer os prints do manual no Mac mini

O manual [manual/claude-code.md](../manual/claude-code.md) foi montado com prints do Linux (tela virtual no codespace). Isso é suficiente, mas no Mac os menus ficam na barra do topo da tela, e o manual fica mais fiel com prints de lá.

## Preparar

1. `npm install` e `npm start`. O modo de desenvolvimento usa a pasta `~/Library/Application Support/Multiverse Dev`, separada do app instalado.
2. Criar duas contas e chamá-las de **Trabalho** e **Pessoal**. Não precisa fazer login.
3. Deixar a janela num tamanho médio, por exemplo 1280×860.

## Prints (mesmos nomes, em `manual/img/`)

Captura de área: **⌘⇧4**. Para um menu aberto, **⌘⇧4** e depois **espaço**, com o clique no menu.

| Arquivo | O que mostrar |
| --- | --- |
| `01-permitir.png` | Clique direito em **Trabalho**, menu aberto com *Permitir Claude Code* |
| `02-menu-contas.png` | Barra do topo: **Contas** aberto, mouse em *Claude Code (MCP)* |
| `03-servidor-ligado.png` | Submenu aberto, com o ✓ em *Servidor ligado* |
| `04-copiar-comando.png` | Submenu aberto, mouse em *Copiar comando do Claude Code* |
| `05-comando-copiado.png` | Diálogo "Comando copiado." |
| `06-estados.png` | Recorte das abas nos 3 estados do 🤖: servidor desligado, ligado, e logo depois de um pedido do Claude Code (fundo verde por cerca de 30 s) |
| `07-retirar.png` | Clique direito em **Trabalho** já liberada: *Retirar acesso do Claude Code* |
| `08-aba-do-claude.png` | Barra com a aba filha 🤖 criada pelo Claude Code (peça "abra example.com na conta Trabalho") |
| `09-espelho.png` | A aba 🤖 aberta: página ao vivo com o aviso no canto superior direito |

Extras que valem a pena no Mac:
- **Terminal:** `claude mcp add …` e `claude mcp list` mostrando *multiverse* conectado.
- **Claude Code:** respondendo a "liste as contas do Multiverse".

## Destaques

Contornar o item a clicar com um retângulo vermelho arredondado. Dá para fazer na Pré-Visualização: *Ferramentas → Anotar → Retângulo*.

## Depois

- Trocar, no manual, a frase "Os prints são da versão Linux…" por "Os prints são do macOS…".
- Revisar os atalhos citados (⌘V) e o caminho do `accounts.json` no Mac: `~/Library/Application Support/Multiverse/accounts.json`.
