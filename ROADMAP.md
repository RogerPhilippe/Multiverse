# Roadmap

## Suporte a outros serviços

- [x] Catálogo em `src/services.js`: Claude, Gemini, ChatGPT, Gmail, Outlook, Google Drive, OneDrive.
- [x] Campo `service` por conta (contas antigas viram `claude`).
- [x] Tela "Nova aba" com um botão por serviço; cor do serviço na aba.
- [x] Popups: login pequeno, páginas do serviço em janela grande, o resto no navegador padrão.
- [x] Carregamento sob demanda (só a aba ativa carrega ao abrir).
- [ ] Ícones de verdade (hoje: letra sobre a cor do serviço).
- [ ] Suspender abas inativas há muito tempo.
- [ ] Opção de abas compartilharem a sessão (ex.: Gmail + Drive + Gemini com um só login Google).

### Login com Google

Já visto no Claude: o popup "Continuar com Google" mostrou **"Não foi possível fazer login. Este navegador ou app pode não ser seguro"**. Afeta também Gemini, Gmail e Drive, que não têm outro login. Causa provável: o User-Agent diz Chrome, mas os Client Hints (`Sec-CH-UA`, `navigator.userAgentData`) dizem Chromium/Electron. Próximos passos, em ordem:

1. Só em `accounts.google.com`: User-Agent de Firefox (que não usa Client Hints) e remover os cabeçalhos `Sec-CH-UA*` (técnica usada por Ferdium/Rambox).
2. Abrir o login numa janela comum do app em vez de popup.
3. Em último caso, logar no navegador do sistema e importar cookies (complexo, evitar).

### Outros riscos

- **ChatGPT** usa Cloudflare, que pode pedir verificação humana. Normalmente passa após o desafio.
- **Downloads** (anexos, arquivos do Drive/OneDrive) usam o diálogo padrão do Electron; se incomodar, tratar `will-download`.

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
- [ ] Opção "Não lembrar login" por conta.

## Outras ideias

- [x] Empacotar (electron-builder) e release automático no GitHub (mac arm64, win x64, linux x64).
- [ ] Assinar e notarizar (Apple Developer ID, certificado Windows) para remover os avisos de segurança.
- [ ] Atualização automática (electron-updater, usando os `latest*.yml` do release).
- [ ] Reordenar abas arrastando.
- [ ] Badge/contador de notificações por aba.
- [ ] Cor personalizada por aba.
- [ ] Lembrar a URL da última conversa de cada aba ao reabrir.
