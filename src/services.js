// Catálogo de serviços. Cada aba (conta) usa um deles.
//
// hosts: domínios que abrem dentro do app para aquele serviço. O resto vai
// para o navegador padrão. Os domínios de login (AUTH_HOSTS) valem para todos.

const escape = (name) => name.replace(/\./g, '\\.');
const domain = (...names) => names.map((n) => new RegExp(`(^|\\.)${escape(n)}$`)); // domínio + subdomínios
const exact = (...names) => names.map((n) => new RegExp(`^${escape(n)}$`));

const AUTH_HOSTS = exact(
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'account.live.com',
);

// A ordem aqui é a ordem dos botões na tela de "Nova aba".
const SERVICES = [
  {
    id: 'claude', name: 'Claude', mark: 'C', color: '#d97757',
    url: 'https://claude.ai/',
    hosts: domain('claude.ai', 'claude.com', 'anthropic.com'),
  },
  {
    id: 'gemini', name: 'Gemini', mark: 'G', color: '#8b6cf0',
    url: 'https://gemini.google.com/app',
    hosts: exact('gemini.google.com'),
  },
  {
    id: 'chatgpt', name: 'ChatGPT', mark: 'GPT', color: '#10a37f',
    url: 'https://chatgpt.com/',
    hosts: domain('chatgpt.com', 'openai.com'),
  },
  {
    id: 'gmail', name: 'Gmail', mark: 'M', color: '#ea4335',
    url: 'https://mail.google.com/mail/',
    hosts: exact('mail.google.com'),
  },
  {
    id: 'outlook', name: 'Outlook', mark: 'O', color: '#0f6cbd',
    url: 'https://outlook.live.com/mail/',
    hosts: exact('outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'),
  },
  {
    id: 'gdrive', name: 'Google Drive', mark: 'D', color: '#1e8e3e',
    url: 'https://drive.google.com/',
    hosts: exact('drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'),
  },
  {
    id: 'onedrive', name: 'OneDrive', mark: '1D', color: '#28a8ea',
    url: 'https://onedrive.live.com/',
    hosts: domain('onedrive.live.com', 'onedrive.com', '1drv.ms', '1drv.com', 'sharepoint.com'),
  },
];

const DEFAULT_SERVICE = 'claude'; // contas antigas (sem campo service) eram todas da claude.ai

module.exports = { SERVICES, AUTH_HOSTS, DEFAULT_SERVICE };
