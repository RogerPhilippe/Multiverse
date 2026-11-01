# Multiverse

> **Cada conta no seu universo.**

App desktop (Electron) para usar várias contas de assistentes de IA ao mesmo tempo, uma por aba. Hoje suporta a [claude.ai](https://claude.ai); ChatGPT e Gemini estão no [ROADMAP.md](ROADMAP.md).

Projeto pessoal e privado. Veja os planos futuros em [ROADMAP.md](ROADMAP.md).

## Por que existe

O navegador guarda um único conjunto de cookies por perfil, então só cabe uma conta logada por vez. Aqui cada aba usa uma **partição de sessão persistente** do Electron (`persist:account-<id>`), com cookies, localStorage e cache próprios. Na prática, cada aba é um navegador independente, e o login continua salvo quando o app é fechado e reaberto.

## Rodar

```bash
npm install
npm start
```

> O `start` usa `env -u ELECTRON_RUN_AS_NODE` porque o terminal do VS Code define essa variável, e com ela o Electron roda como Node puro e não abre a janela.

## Uso

| Ação | Como |
| --- | --- |
| Nova conta | `+` na barra ou ⌘T |
| Renomear aba | Duplo clique na aba |
| Remover conta (apaga o login) | `×` na aba |
| Trocar de aba | ⌘1…⌘9, Ctrl+Tab / Ctrl+Shift+Tab |
| Recarregar aba | ⌘R ou clique do meio na aba |
| Voltar / avançar | ⌘[ / ⌘] |
| Voltar à página inicial | ⌘⇧H |
| Zoom | ⌘+ / ⌘− / ⌘0 |
| DevTools da aba | ⌥⌘I |

- Os links externos abertos nas conversas vão para o navegador padrão.
- Os popups de login (Google/Apple) abrem dentro do app, na sessão da aba que os abriu.
- **Login com Google** pode ser bloqueado em apps Electron. O app se identifica como Chrome comum para reduzir isso. Se o Google bloquear mesmo assim, entre com e-mail (link ou código).

## Estrutura

```
src/
  main.js      processo principal: janela, abas (WebContentsView), sessões, menu/atalhos
  preload.js   ponte segura (contextBridge) entre a barra de abas e o main
  tabbar.html  barra de abas
  tabbar.js    lógica da barra (renderizar, adicionar, renomear, remover)
build/
  icon.svg     fonte do ícone (três anéis = três universos)
  icon.png     1024px, gerado
  icon.icns    macOS, gerado
scripts/
  build-icons.js  gera icon.png e icon.icns a partir do SVG (`npm run icons`)
```

## Dados

- Lista de contas: `~/Library/Application Support/Multiverse/accounts.json`
- Sessões (cookies etc.): `~/Library/Application Support/Multiverse/Partitions/`

O caminho vem do `productName` do `package.json`. Os dados da época em que o app se chamava `claude-browser` são migrados automaticamente na primeira execução.
