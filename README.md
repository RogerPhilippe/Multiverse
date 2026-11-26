# Multiverse

> **Cada conta no seu universo.**

App desktop (Electron) para usar várias contas da [claude.ai](https://claude.ai) ao mesmo tempo, uma por aba. Outros serviços foram testados e deixados de fora; veja o [ROADMAP.md](ROADMAP.md).

Projeto pessoal. Veja os planos futuros em [ROADMAP.md](ROADMAP.md).

## Por que existe

O navegador guarda um único conjunto de cookies por perfil, então só cabe uma conta logada por vez. Aqui cada aba usa uma **partição de sessão persistente** do Electron (`persist:account-<id>`), com cookies, localStorage e cache próprios. Na prática, cada aba é um navegador independente, e o login continua salvo quando o app é fechado e reaberto.

## Rodar

```bash
npm install
npm start
```

> O `start` usa `env -u ELECTRON_RUN_AS_NODE` porque o terminal do VS Code define essa variável, e com ela o Electron roda como Node puro e não abre a janela.

## Gerar instaladores

Localmente (sai em `dist/`):

```bash
npm run dist -- --mac --arm64     # ou --win --x64, --linux --x64
```

### Release no GitHub

O workflow [.github/workflows/release.yml](.github/workflows/release.yml) gera os instaladores e cria o release quando uma tag `v*` é enviada:

```bash
npm version patch          # 1.0.0 → 1.0.1 (ou minor/major); cria commit + tag
git push --follow-tags
```

| Sistema | Arquivos |
| --- | --- |
| macOS Apple Silicon | `.dmg`, `.zip` |
| Windows x64 | `.exe` (instalador NSIS) |
| Linux x64 | `.AppImage`, `.deb` |

O workflow falha se a tag não bater com a `version` do `package.json`.

### Instaladores sem assinatura

O app não tem certificado da Apple nem da Microsoft:

- **macOS:** depois de baixar, o sistema pode dizer que o app está "danificado". Para liberar:
  ```bash
  xattr -cr /Applications/Multiverse.app
  ```
- **Windows:** o SmartScreen avisa "O Windows protegeu o computador". Clique em *Mais informações → Executar assim mesmo*.

## Uso

| Ação | Como |
| --- | --- |
| Nova conta | `+` na barra ou ⌘T |
| Renomear aba | Duplo clique na aba |
| Remover conta (fecha a aba na hora; login e dados são apagados em segundo plano) | Clique direito na aba → *Remover conta…* |
| Aba filha (mesma sessão da conta, abre uma URL colada) | Clique direito na aba → *Nova aba filha…*, ou ⌘⇧T |
| Fechar aba filha (a conta continua logada) | `×` na aba filha ou ⌘W |
| PIN na conta (vale também para as abas filhas) | Clique direito na aba → *Definir PIN…* |
| Remover PIN (pede o PIN atual) | Clique direito → *Remover PIN…* |
| Liberar a conta para o Claude Code (MCP) | Clique direito na aba → *Permitir Claude Code* |
| Ligar o servidor do Claude Code e copiar o comando | Menu *Contas → Claude Code (MCP)* |
| Trocar de aba | ⌘1…⌘9, Ctrl+Tab / Ctrl+Shift+Tab |
| Recarregar aba | ⌘R ou clique do meio na aba |
| Voltar / avançar | ⌘[ / ⌘] |
| Voltar à página inicial | ⌘⇧H |
| Zoom | ⌘+ / ⌘− / ⌘0 |
| DevTools da aba | ⌥⌘I |

- Só a aba ativa carrega ao abrir o app; as outras carregam na primeira vez que são abertas. Enquanto a aba carrega, a bolinha vira um anel girando.
- **Abas filhas** usam os mesmos cookies da aba pai, então abrem a URL já logadas nessa conta. Servem, por exemplo, para o login do Claude Code: copie o link que ele mostra, crie uma aba filha na conta certa, cole o link, autorize e copie o código. O campo da URL fica aberto até você colar (Enter) ou cancelar (Esc). As filhas não são salvas: somem ao fechar o app.
- **PIN:** uma conta com PIN abre bloqueada toda vez que o app inicia; a página só carrega depois do PIN certo, e fica desbloqueada até o app ser fechado. As abas filhas seguem a regra da conta (desbloquear a conta libera as filhas); definir e remover o PIN só na aba da conta. O PIN é guardado só como hash (scrypt). Ele protege a interface, não os arquivos: os cookies no disco não são criptografados (veja o ROADMAP).
- **Claude Code (MCP):** o Multiverse pode ser um servidor MCP local (só `127.0.0.1`, porta 47821, com token), desligado por padrão. Para usar:
  1. Ligue em *Contas → Claude Code (MCP) → Servidor ligado*.
  2. Libere as contas desejadas pelo clique direito (aparece 🤖 na aba; com fundo verde quando o Claude Code está usando).
  3. Rode no terminal o comando de *Copiar comando do Claude Code*.

  Ele lê a aba da conta e trabalha em abas filhas próprias (🤖): abre páginas, clica, digita e tira prints, em segundo plano, mesmo com o Multiverse minimizado. Clicando na aba dele, você vê a página ao vivo e pode interagir. Contas bloqueadas por PIN ficam inacessíveis. Passo a passo com prints: [manual/claude-code.md](manual/claude-code.md). Plano completo: [planos/mcp-claude-code.md](planos/mcp-claude-code.md).
- Os links externos abertos nas conversas vão para o navegador padrão.
- Os popups de login (Google/Apple) abrem dentro do app, na sessão da aba que os abriu.
- **Login com Google não funciona:** o Google bloqueia apps Electron ("Este navegador ou app pode não ser seguro"). Entre com e-mail: a claude.ai envia um código, sem senha.

## Estrutura

```
src/
  main.js      processo principal: janela, abas (WebContentsView), sessões, menu/atalhos
  mcp.js       servidor MCP local para o Claude Code (as regras ficam em main.js)
  preload.js   ponte segura (contextBridge) entre a barra de abas e o main
  tabbar.html  barra de abas
  tabbar.js    lógica da barra (renderizar, adicionar, renomear, remover)
build/
  icon.svg     fonte do ícone (três anéis = três universos)
  icon.png     1024px, gerado
  icon.icns    macOS, gerado
.github/workflows/
  release.yml     build mac/win/linux e release no GitHub
scripts/
  build-icons.js  gera icon.png e icon.icns a partir do SVG (`npm run icons`)
```

## Dados

- Lista de contas: `~/Library/Application Support/Multiverse/accounts.json`
- Sessões (cookies etc.): `~/Library/Application Support/Multiverse/Partitions/`

O caminho vem do `productName` do `package.json`. Em desenvolvimento (`npm start`), o app usa `~/Library/Application Support/Multiverse Dev/`, para nunca disputar dados com o app instalado. Só uma instância roda por pasta de dados: abrir de novo traz a janela existente para frente.

**Segurança:** o login fica salvo de propósito, para não pedir credenciais a cada abertura. Os cookies ficam nos arquivos acima, protegidos pelas permissões do usuário (ainda sem criptografia; veja o [ROADMAP.md](ROADMAP.md)). Para apagar um login, use *Remover conta…*.
