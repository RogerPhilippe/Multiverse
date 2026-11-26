# Plano: acesso do Claude Code às abas do Multiverse (MCP)

O Multiverse passa a ser um **servidor MCP local**. O Claude Code se conecta a ele e trabalha nas abas de uma conta que você liberou, usando o login dela, no mesmo modelo do Claude in Chrome. Não precisa de plugin, porque o Electron já controla as próprias abas (`webContents`).

## Regras (decididas)

| Item | Regra |
| --- | --- |
| Quais contas | Só as marcadas pelo clique direito → **Permitir Claude Code**. Pode haver várias. |
| Aba da conta (pai) | **Só leitura:** URL, título, texto e print. Ele não clica, não digita, não navega, e nunca cria nem fecha abas de conta. |
| Abas filhas | Ele **cria** filhas da conta liberada e nelas pode tudo: navegar, ler, clicar, digitar, tirar print e rodar JavaScript. |
| Fechar | Só as filhas **que ele criou**. As filhas abertas por você ficam fora do alcance dele, inclusive para ler. |
| PIN | Uma conta bloqueada por PIN fica inacessível: as ferramentas respondem "conta bloqueada". |
| Retirar a permissão | Fecha na hora as filhas criadas por ele naquela conta. |

## Como o Claude Code se conecta

- O servidor começa **desligado**. Ele é ligado no menu *Contas → Claude Code (MCP) → Ligar servidor*, e a escolha fica salva.
- **Endereço:** só `127.0.0.1`, porta fixa `47821`, transporte *Streamable HTTP* em `/mcp`. Se a porta estiver ocupada, aparece um aviso. A porta pode ser trocada nas configurações.
- **Token:** é gerado na primeira vez e salvo em `userData/mcp-token`. Toda requisição precisa de `Authorization: Bearer <token>`. O menu *Copiar comando do Claude Code* copia o comando pronto:
  ```bash
  claude mcp add --transport http multiverse http://127.0.0.1:47821/mcp \
    --header "Authorization: Bearer <token>"
  ```
- *Gerar novo token* invalida o anterior.
- **Proteção contra sites maliciosos (DNS rebinding):** são recusadas as requisições com `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>` e as que trazem um cabeçalho `Origin` de páginas web.

## Ferramentas MCP

Os ids de aba são os UUIDs que o app já usa. Qualquer violação das regras devolve um erro claro, por exemplo "aba não criada pelo Claude Code".

**Contas (pai), somente leitura**
- `list_accounts`: devolve as contas liberadas `{ id, nome, bloqueada }` e, para cada uma, as filhas criadas pelo agente `{ id, url, título, carregando }`.
- `read_account_tab(account_id, max_chars?)`: URL, título e texto visível (`innerText`, truncado).
- `screenshot_account_tab(account_id)`: imagem PNG.

**Filhas criadas pelo agente**
- `create_child(account_id, url)`: cria a filha em segundo plano, sem trocar a aba que você está vendo. Devolve o `child_id`. O limite é de 5 por conta.
- `close_child(child_id)`
- `navigate(child_id, url)`, `go_back`, `go_forward` e `reload`
- `snapshot(child_id)`: texto da página mais a lista de elementos interativos (links, botões, campos), cada um com uma referência numerada (`ref`) para usar nas ações abaixo.
- `click(child_id, ref | {x, y})`
- `type(child_id, ref, text, submit?)` e `press_key(child_id, key)`
- `screenshot(child_id)`
- `eval_js(child_id, code)`: devolve o resultado em JSON, truncado.
- `wait_for(child_id, { selector? | load? }, timeout_ms?)`

## Mudanças no app

**Estado (`main.js`)**
- `account.mcpAllowed: boolean` é salvo no `accounts.json`.
- `child.createdBy: 'user' | 'agent'` fica só em memória, porque as filhas não são salvas.

**Barra de abas**
- Contas liberadas mostram um ícone (🤖).
- As filhas do agente mostram o mesmo ícone, e você pode fechá-las normalmente pelo ×.
- Enquanto há um cliente conectado, o ícone da conta fica aceso.

**Clique direito na conta**
- *Permitir Claude Code* / *Retirar acesso do Claude Code*.
- Fica desativado enquanto a conta está bloqueada por PIN.

**Filhas do agente**
- **Downloads:** são cancelados (`will-download`).
- **Câmera e microfone:** são negados. O controle de permissões é por sessão, então ele checa se o `webContents` pertence a uma filha do agente.
- **Popups:** um `window.open` vira uma nova filha do agente, dentro do limite. Links externos continuam indo para o navegador.

**Leitura de páginas**
- Usa `webContents.executeJavaScript` num *isolated world* (`executeJavaScriptInIsolatedWorld`), para não interferir nos scripts da página.

**Ações de clique e teclado**
- Usam `webContents.sendInputEvent`, que gera eventos confiáveis (`isTrusted`), como os de uma pessoa.

**Abas escondidas, minimizado, coberto:** veja "Decisões técnicas" abaixo. As filhas do agente são janelas invisíveis offscreen, e o usuário as vê por um espelho ao vivo.

**Dependências**
- `@modelcontextprotocol/sdk` e `zod` entram em `dependencies`, não em `devDependencies`, para irem no instalador.
- O código fica num módulo novo, `src/mcp.js`. O `main.js` só expõe funções de abas para ele.

## Situação: concluído (etapas 1 a 4)

Testado de ponta a ponta no codespace (Linux, tela virtual com gerenciador de janelas), com o cliente MCP do SDK contra o app, **também no app empacotado**. São 34 verificações, todas ok, em três cenários:

- **A:** usuário em outra aba.
- **B:** outro programa na frente.
- **C:** Multiverse **minimizado**.

O espelho foi testado com clique, digitação com acentos, Backspace, Ctrl+V, Enter e rolagem. Fechar a janela principal encerra o app e as janelas invisíveis.

Falta só o teste no Windows e no macOS pelo usuário.

## Decisões técnicas (o que os testes mostraram)

1. **Aba escondida comum não serve para o agente.** O Chromium não desenha uma aba escondida. Sem superfície de desenho, o print dá erro e **os cliques somem em silêncio**: isso vale para a aba nunca mostrada e depois de cada navegação. O teclado continua funcionando. O protocolo de depuração (`Page.captureScreenshot`) trava.
2. **Truque de 1 px** (a aba fica visível quase toda fora da janela durante a ação): resolve com a janela à mostra, mas **falha com o Multiverse minimizado ou coberto**. Ficou só para o print da **aba da conta** (`withSurface`), que é uma aba normal.
3. **Filhas do agente = janela invisível offscreen** (`createAgentHost`):
   - É um `BrowserWindow` com `show: false`, `offscreen: true`, `backgroundThrottling: false` e `skipTaskbar`.
   - Desenha na memória, independente da janela principal: print, clique e digitação funcionam minimizado, coberto ou em outra aba, sem roubar o foco.
   - `WebContentsView` offscreen **não** serve: ignora `setBounds`, fica do tamanho da janela inteira e, fora dela, fica com tamanho 0.
   - O tamanho da janela invisível acompanha a área das abas (`setContentSize`).
   - Ao fechar a janela principal, as invisíveis são destruídas; senão o app não encerra.
4. **Espelho:** o usuário vê a filha do agente pelos quadros do evento `paint` (JPEG, ~15 por segundo quando aberta, 4 por segundo em segundo plano), mostrados na barra.
   - Cliques, rolagem e teclas voltam por `mirror:input` → `sendInputEvent`.
   - O texto passa por um `<textarea>` invisível, para pegar acentos, teclas mortas, IME e colar.
5. **Cliques e teclas** do agente usam `sendInputEvent`, ou seja, eventos confiáveis (`isTrusted`). Texto usa `insertText`. A leitura de página roda num *isolated world*. `eval_js` roda no mundo da página.

## Etapas

1. **Base** ✅ feita: servidor ligado e desligado pelo menu, token, checagem de `Host`/`Origin`, opção *Permitir Claude Code*, `list_accounts`, `read_account_tab` e `screenshot_account_tab`. Também o indicador 🤖 na barra, adiantado da etapa 4.
   - Testado com o cliente MCP do SDK contra o app rodando (Linux, tela virtual): leitura e print da aba ativa e da escondida, recusa da conta não liberada e da bloqueada por PIN, token ausente ou errado (401), `Origin` (403), `Host` estranho (403), GET (405) e porta ocupada.
   - Falta testar no Windows com o Claude Code de verdade.
2. **Filhas** ✅ `create_child`, `close_child`, navegação, `read_page`, `screenshot` e as regras de "só as que criou" e de PIN.
3. **Interação** ✅ `snapshot` com `ref`, `click`, `type`, `press_key`, `scroll`, `eval_js` e `wait_for`.
4. **Acabamento** ✅ (falta o teste no Windows):
   - Ícones e indicador de conexão.
   - Limite de filhas, bloqueio de downloads, câmera e microfone.
   - README e ROADMAP.
   - Testar no instalador de Windows (o servidor HTTP dentro do app empacotado e o aviso do firewall).

## Riscos e pontos a validar

- **Firewall do Windows:** ouvir só em `127.0.0.1` normalmente não gera aviso. Confirmar na etapa 4.
- **Abas escondidas, minimizado, coberto:** resolvido com as janelas offscreen (veja "Decisões técnicas"). Fica pendente conferir no Windows e no macOS, porque o teste foi no Linux. O único caso que ainda depende da janela à mostra é o **print da aba da conta**; nele, a ferramenta devolve uma mensagem clara.
- **Sites que detectam automação:** como os eventos são confiáveis e o User-Agent é de Chrome, o risco é baixo. Mesmo assim, alguns sites podem estranhar.
- **Segurança:** quem tiver o token controla as filhas das contas liberadas. Mitigações:
  - O servidor começa desligado.
  - O token fica só na pasta do app.
  - A liberação é por conta e pode ser retirada.
  - O PIN tem prioridade sobre a liberação.
