# Roadmap

## Outros serviços (testado e descartado)

Na versão 1.1.0 o app teve Gemini, ChatGPT, Gmail, Outlook, Google Drive e OneDrive, escolhidos numa tela de "Nova aba". Foi revertido para **só Claude**: os outros não funcionaram bem, principalmente com contas Google. O código está no histórico do git (commits da 1.1.0).

**Login do Google** ("Este navegador ou app pode não ser seguro"), tentativas:

1. User-Agent de Chrome: bloqueado.
2. Fingir Firefox em `accounts.google.com` (cabeçalhos + `navigator`): a página via Firefox de fato, e mesmo assim bloqueou. O BotGuard do Google testa o motor (WebGPU, etc.), não só o que o navegador diz ser.
3. Fingir Google Chrome completo (marca "Google Chrome" nos Client Hints). Depois disso, a decisão foi manter só o Claude.

Descartado: abrir os serviços num navegador de verdade (Edge/Chrome) fora das abas, porque tira a função principal do app; importar cookies de outro navegador (frágil, sessões presas ao dispositivo).

Ficaram da 1.1.0: carregamento sob demanda com indicador na aba e remoção de conta em segundo plano. Abas de outros serviços criadas na 1.1.0 são removidas ao abrir, e os dados delas apagados.

## Identidade

- [x] Nome genérico: **Multiverse** (antes `claude-browser`).
- [x] Slogan: **"Cada conta no seu universo."**
- [ ] Renomear a pasta do projeto (`ClaudeBrowser` → `Multiverse`).
- [x] Ícone do app (`build/icon.svg`, gerado com `npm run icons`).

Ao mudar o `productName` de novo, lembrar que a pasta de dados vem dele: sem migração, os logins salvos não são encontrados.

## Segurança

- [x] Remover conta pelo clique direito (apaga login e dados, fecha a aba).
- [x] Instância única e pasta de dados separada em desenvolvimento.
- [ ] Criptografar cookies com chave no Chaveiro do sistema (fuse `EnableCookieEncryption`).
- [ ] Desligar fuses de depuração no app empacotado (`RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`) e ligar a validação de integridade do asar.
- [x] PIN por conta (pedido ao abrir o app; abas filhas seguem a conta).
- [ ] Bloquear manualmente ou após um tempo sem uso.
- [ ] Opção "Não lembrar login" por conta.

## Outras ideias

- [x] Empacotar (electron-builder) e release automático no GitHub (mac arm64, win x64, linux x64).
- [ ] Assinar e notarizar (Apple Developer ID, certificado Windows) para remover os avisos de segurança.
- [ ] Atualização automática (electron-updater, usando os `latest*.yml` do release).
- [x] Abas filhas: mesma sessão da aba pai, abertas a partir de uma URL colada (ex.: login do Claude Code).
- [x] Claude Code via MCP: lê a aba da conta e trabalha em abas filhas próprias, offscreen, mesmo com o app minimizado ([planos/mcp-claude-code.md](planos/mcp-claude-code.md), [manual](manual/claude-code.md)).
- [ ] Conectores da claude.ai dentro do app ([planos/conectores.md](planos/conectores.md)).
- [ ] Reordenar abas arrastando.
- [ ] Badge/contador de notificações por aba.
- [ ] Cor personalizada por aba.
- [ ] Lembrar a URL da última conversa de cada aba ao reabrir.
