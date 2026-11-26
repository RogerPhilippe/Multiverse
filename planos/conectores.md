# Plano: conectores da claude.ai funcionando dentro do Multiverse

## Situação hoje

- Os conectores (GitHub, Notion, MCP remoto personalizado…) ficam salvos **na conta da claude.ai** e são chamados pelos servidores da Anthropic. Depois de conectados, já funcionam em cada aba, isolados por conta. As abas filhas usam os da conta pai.
- **O problema é a hora de conectar.** A claude.ai abre um popup de autorização (OAuth) no site do serviço. Em `src/main.js` (`setWindowOpenHandler`), popups para domínios fora de `INTERNAL_HOSTS` vão para o **navegador padrão**. Lá a sessão da claude.ai é outra, ou não existe. O retorno (`claude.ai/...callback`) cai na conta errada, e a conexão falha ou é salva na conta errada.

## Objetivo

Popups de autorização abertos pela claude.ai completam **dentro do app, na sessão da aba que os abriu**. Links comuns das conversas continuam indo para o navegador.

## Regra nova no `setWindowOpenHandler`

Um popup abre dentro do app, com a mesma partição da aba, se valer **qualquer** destas condições:

1. o domínio está em `INTERNAL_HOSTS` (como hoje);
2. **é uma URL de OAuth que volta para a claude.ai:** o parâmetro `redirect_uri` aponta para `claude.ai`, `claude.com` ou `anthropic.com`. É o sinal mais preciso, porque não depende de como a página abriu o popup;
3. a aba que abre está num domínio interno **e** o pedido chegou como `disposition: 'new-window'`, ou seja, um `window.open` com tamanho, que é o formato típico de popup de login.

Qualquer outro caso (`foreground-tab`/`background-tab`, que são links clicados) segue para o navegador padrão.

## Janela de autorização

- **Configuração:** é uma janela filha da principal, de 520×720, com a mesma partição da aba e `sandbox`/`contextIsolation` ligados.
- **Título:** mostra o domínio atual (por exemplo, "Autorizar — github.com") e é atualizado a cada navegação. Você sempre sabe em que site está digitando a senha.
- **Popups dentro dela:** seguem a mesma regra, por exemplo um login do serviço que abre outro popup.
- **Fechamento:** quando a claude.ai termina, ela fecha a janela sozinha (`window.close()`, porque tem `opener`). Se não fechar, a janela fecha ao navegar de volta para o callback da claude.ai e terminar de carregar.
- **Permissões:** o mesmo controle restrito de permissões da sessão.

## Conectores do Google (Drive, Gmail, Agenda)

O Google recusa o login dentro do Electron (veja o README e o ROADMAP). Três tentativas de enganar o bloqueio já falharam, então **o login no Google precisa acontecer num navegador de verdade**. A ideia é separar as duas metades da autorização: só a parte do Google sai do app, e a parte da conta da claude.ai continua na aba certa. Assim, não é preciso logar a claude.ai no navegador.

**Hipótese a confirmar antes de tudo.** A autorização termina numa URL de retorno da claude.ai (`claude.ai/...callback?code=…&state=…`). Abrir essa URL **na aba do Multiverse** salvaria o conector naquela conta, mesmo que o login no Google tenha acontecido em outro navegador. Teste manual, com o que já existe:

1. Na aba da conta, clicar em *Conectar* num conector do Google. O popup vai para o navegador padrão.
2. Autorizar no navegador e copiar a URL de retorno da claude.ai, mesmo que a página dê erro ali.
3. Colar essa URL numa aba filha da conta e ver se o conector aparece conectado.

Se a claude.ai amarrar o retorno ao navegador onde a autorização começou, as opções 1 e 2 caem, e só sobra o contorno.

**Opções, se a hipótese se confirmar:**

1. **Retorno colado (semiautomático).**
   - O popup do Google abre no navegador padrão.
   - Depois de autorizar, você cola a URL de retorno num campo do Multiverse, que conclui a conexão na sessão da aba. Reaproveita o campo da aba filha.
   - É simples de fazer, e não precisa do login da claude.ai no navegador.
2. **Retorno capturado (automático).**
   - O Multiverse abre o Chrome ou Edge instalado, com um perfil próprio do app que guarda só o login do Google.
   - Ele acompanha a navegação (protocolo de depuração) e, ao chegar na URL de retorno, fecha o navegador e conclui a conexão na aba.
   - Você não copia nada. O risco é o Google bloquear o login num navegador acompanhado por outro programa; precisa de teste.
3. **Login no Google dentro do app:** descartado (já tentado).

**Contorno que funciona hoje:** conectar uma vez num navegador comum, logado na **mesma conta** da claude.ai. Como o conector fica salvo na conta, ele aparece na aba do Multiverse.

**Situação:** em aberto. A ordem sugerida é testar a hipótese, depois fazer a opção 1 e, mais tarde, a 2.

## Etapas

1. **Investigação.** Em desenvolvimento, registrar no console o que o `setWindowOpenHandler` recebe (`url`, `disposition`, `features`, `frameName`) ao clicar em *Conectar* em alguns conectores: GitHub, Notion e um MCP remoto personalizado. Isso confirma qual das regras 2 e 3 pega cada caso.
2. **Implementação.**
   - Funções `isOAuthToInternal(url)` e `shouldOpenInApp(details, openerUrl)`.
   - Mudança no `setWindowOpenHandler`.
   - Título com o domínio.
3. **Testes.**
   - Conectar GitHub e Notion em **duas contas ao mesmo tempo** e conferir que cada uma fica só com o seu.
   - Um MCP remoto com OAuth.
   - Links comuns de uma conversa continuam indo para o navegador.
   - A aba filha também consegue conectar (mesma sessão da pai).
   - Testar no instalador de Windows.
4. **Docs.** No README, explicar os conectores por conta e o contorno do Google. Marcar no ROADMAP.

## Riscos

- **Formato do popup:** se a claude.ai abrir a autorização como um link comum, sem `redirect_uri` visível na URL inicial (por exemplo, passando antes por uma URL própria da claude.ai que redireciona), a regra 1 já cobre o primeiro passo. O redirecionamento seguinte acontece dentro da janela, que aceita navegar para qualquer domínio. A etapa 1 confirma isso.
- **Phishing:** como a janela não tem barra de endereço, o título com o domínio é a defesa. Ela só abre a partir de páginas da claude.ai, nunca de um site qualquer.
