# Roadmap

## Suporte a outros serviços (ChatGPT, Gemini…)

**Objetivo:** ao criar uma aba, escolher o serviço (Claude, ChatGPT, Gemini…), mantendo várias contas de cada um, todas isoladas.

### Por que é viável

O isolamento já é por **conta**, não por serviço: cada aba tem a própria partição. Basta parametrizar o que hoje está fixo para a claude.ai:

| Hoje (fixo em `src/main.js`) | Passa a ser |
| --- | --- |
| `START_URL = 'https://claude.ai/'` | `service.url` |
| `INTERNAL_HOSTS` (domínios que abrem dentro do app) | `service.hosts` + domínios de login comuns |
| Bolinha com cor por posição | Ícone/cor do serviço |

### Proposta

1. **Catálogo de serviços** (ex.: `src/services.js`):

   ```js
   module.exports = {
     claude:  { name: 'Claude',  url: 'https://claude.ai/',
                hosts: [/(^|\.)claude\.ai$/, /(^|\.)claude\.com$/, /(^|\.)anthropic\.com$/] },
     chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/',
                hosts: [/(^|\.)chatgpt\.com$/, /(^|\.)openai\.com$/] },
     gemini:  { name: 'Gemini',  url: 'https://gemini.google.com/',
                hosts: [/^gemini\.google\.com$/] },
   };
   ```
   Os domínios de login compartilhados (`accounts.google.com`, `appleid.apple.com`, `login.microsoftonline.com`) ficam numa lista comum.

2. **Campo `service` em cada conta** no `accounts.json`.
   - Migração: conta sem `service` é tratada como `claude`. Os logins existentes continuam funcionando.

3. **UI**: o `+` abre um pequeno menu para escolher o serviço antes de digitar o nome. A aba mostra o ícone do serviço (favicon via evento `page-favicon-updated` ou ícone local).

4. **Atalhos**: sem mudança, ⌘1…⌘9 seguem a ordem das abas.

### Riscos

- **Gemini depende de login Google**, o mais propenso a bloquear navegadores embutidos ("este navegador pode não ser seguro"). Mitigações, em ordem:
  1. User-Agent de Chrome (já aplicado);
  2. abrir o login numa janela comum do app em vez de um popup;
  3. em último caso, logar no navegador do sistema e importar cookies (complexo, evitar).
- **ChatGPT** usa Cloudflare, que pode pedir verificação humana em navegadores "diferentes". Normalmente passa após o desafio.
- Cada aba é um processo Chromium. Com muitas abas, considerar **carregamento sob demanda** (criar a view só na primeira ativação) e **suspender** abas inativas.

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
