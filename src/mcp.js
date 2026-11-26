// Servidor MCP local: o Claude Code se conecta aqui para trabalhar nas abas das
// contas que o usuário liberou (clique direito → "Permitir Claude Code").
// Regras e etapas: planos/mcp-claude-code.md.
//
// Este módulo não conhece abas nem janelas: recebe de main.js um objeto `api`
// com as operações permitidas, e é lá que as regras (liberação, PIN) são checadas.

const http = require('node:http');
const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');

const MAX_BODY = 1024 * 1024; // 1 MiB por requisição

// Erro com mensagem para o Claude Code (ex.: "conta bloqueada por PIN").
class ToolError extends Error {}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

// Converte ToolError (e falhas inesperadas) em resposta de erro da ferramenta.
function tool(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof ToolError ? err.message : `Erro interno: ${err.message}` }] };
    }
  };
}

const json = (value) => text(value);
const png = (buf) => ({ content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] });

const accountId = z.string().describe('id da conta, de list_accounts');
const childId = z.string().describe('id da aba filha, de create_child ou list_accounts');
const maxChars = z.number().int().min(100).max(200000).optional().describe('limite de caracteres do texto (padrão 20000)');

function buildServer(api, version) {
  const server = new McpServer({ name: 'multiverse', version }, {
    instructions:
      'Multiverse é um app com várias contas da claude.ai, cada uma numa aba com o próprio login. ' +
      'O usuário libera contas para você. A aba da conta é só leitura. Para navegar e agir, crie abas ' +
      'filhas (create_child): elas usam o login da conta, ficam em segundo plano e só você as controla. ' +
      'Fluxo típico: list_accounts → create_child → snapshot → click/type → snapshot/screenshot → close_child.',
  });
  const reg = (name, title, description, inputSchema, fn) =>
    server.registerTool(name, { title, description, inputSchema }, tool(fn));

  // --- contas ---
  reg('list_accounts', 'Listar contas liberadas',
    'Lista as contas do Multiverse liberadas para você, com as abas filhas que você criou em cada uma. ' +
    'Contas bloqueadas por PIN aparecem com locked: true e não podem ser usadas até o usuário desbloquear.',
    {}, async () => json(api.listAccounts()));

  reg('read_account_tab', 'Ler a aba da conta',
    'Lê a URL, o título e o texto visível da aba da conta (somente leitura).',
    { account_id: accountId, max_chars: maxChars },
    async ({ account_id, max_chars }) => json(await api.readAccountTab(account_id, max_chars ?? 20000)));

  reg('screenshot_account_tab', 'Print da aba da conta',
    'Tira um print (PNG) da aba da conta (somente leitura).',
    { account_id: accountId },
    async ({ account_id }) => png(await api.screenshotAccountTab(account_id)));

  // --- abas filhas ---
  reg('create_child', 'Criar aba filha',
    'Cria uma aba filha da conta, já logada com a sessão dela, e abre a URL. Fica em segundo plano ' +
    '(não atrapalha o usuário). Limite: 5 por conta. Devolve child_id.',
    { account_id: accountId, url: z.string().describe('endereço http(s)') },
    async ({ account_id, url }) => json(await api.createChild(account_id, url)));

  reg('close_child', 'Fechar aba filha',
    'Fecha uma aba filha que você criou. O login da conta não é afetado.',
    { child_id: childId }, async ({ child_id }) => json(api.closeChild(child_id)));

  reg('navigate', 'Abrir URL na aba filha', 'Abre uma URL na aba filha e espera carregar.',
    { child_id: childId, url: z.string().describe('endereço http(s)') },
    async ({ child_id, url }) => json(await api.navigate(child_id, url)));

  reg('go_back', 'Voltar', 'Volta para a página anterior da aba filha.',
    { child_id: childId }, async ({ child_id }) => json(await api.history(child_id, 'back')));
  reg('go_forward', 'Avançar', 'Avança para a página seguinte da aba filha.',
    { child_id: childId }, async ({ child_id }) => json(await api.history(child_id, 'forward')));
  reg('reload', 'Recarregar', 'Recarrega a aba filha.',
    { child_id: childId }, async ({ child_id }) => json(await api.history(child_id, 'reload')));

  reg('read_page', 'Ler a aba filha', 'Lê a URL, o título e o texto visível da aba filha.',
    { child_id: childId, max_chars: maxChars },
    async ({ child_id, max_chars }) => json(await api.readPage(child_id, max_chars ?? 20000)));

  reg('snapshot', 'Elementos da página',
    'Lista os elementos interativos da aba filha (links, botões, campos, editores), cada um com um número ' +
    '[ref] para usar em click, type e scroll, mais o texto da página. Rode de novo depois que a página mudar: ' +
    'os números valem só para o último snapshot.',
    {
      child_id: childId,
      max_chars: maxChars,
      max_elements: z.number().int().min(10).max(1000).optional().describe('limite de elementos (padrão 300)'),
    },
    async ({ child_id, max_chars, max_elements }) => text(await api.snapshot(child_id, max_chars ?? 8000, max_elements ?? 300)));

  reg('screenshot', 'Print da aba filha', 'Tira um print (PNG) da aba filha.',
    { child_id: childId }, async ({ child_id }) => png(await api.screenshot(child_id)));

  reg('click', 'Clicar',
    'Clica num elemento (ref, de snapshot) ou numa coordenada da página (x, y em pixels, como no screenshot). ' +
    'Rola até o elemento antes. Devolve a URL e o título depois do clique.',
    {
      child_id: childId,
      ref: z.number().int().optional().describe('número do elemento, de snapshot'),
      x: z.number().optional(), y: z.number().optional(),
      double: z.boolean().optional().describe('clique duplo'),
      button: z.enum(['left', 'right', 'middle']).optional(),
    },
    async ({ child_id, ...opts }) => json(await api.click(child_id, opts)));

  reg('type', 'Digitar',
    'Digita texto num campo (ref, de snapshot), ou onde estiver o foco se ref for omitido. ' +
    'clear: apaga o conteúdo antes. submit: tecla Enter no fim.',
    {
      child_id: childId,
      text: z.string(),
      ref: z.number().int().optional().describe('número do campo, de snapshot'),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
    },
    async ({ child_id, ...opts }) => json(await api.type(child_id, opts)));

  reg('press_key', 'Tecla',
    'Pressiona uma tecla ou combinação na aba filha: Enter, Tab, Escape, Backspace, Delete, ArrowDown, ' +
    'PageDown, Home, uma letra, ou combinações como Control+A, Shift+Tab, Meta+Enter.',
    { child_id: childId, key: z.string() },
    async ({ child_id, key }) => json(await api.pressKey(child_id, key)));

  reg('scroll', 'Rolar', 'Rola a aba filha até um elemento (ref) ou dy pixels (negativo sobe).',
    { child_id: childId, ref: z.number().int().optional(), dy: z.number().optional() },
    async ({ child_id, ...opts }) => json(await api.scroll(child_id, opts)));

  reg('wait_for', 'Esperar',
    'Espera a aba filha terminar de carregar e, se informado, um seletor CSS e/ou um texto aparecerem.',
    {
      child_id: childId,
      selector: z.string().optional(),
      text: z.string().optional(),
      timeout_ms: z.number().int().min(100).max(60000).optional().describe('padrão 10000'),
    },
    async ({ child_id, selector, text: t, timeout_ms }) => json(await api.waitFor(child_id, { selector, text: t, timeoutMs: timeout_ms ?? 10000 })));

  reg('eval_js', 'Rodar JavaScript',
    'Roda JavaScript na página da aba filha (no contexto da própria página) e devolve o resultado em JSON. ' +
    'Use uma expressão; para várias instruções, uma função auto-executável: (() => { ...; return x })(). ' +
    'Promises são aguardadas.',
    { child_id: childId, code: z.string(), max_chars: maxChars },
    async ({ child_id, code, max_chars }) => json(await api.evalJs(child_id, code, max_chars ?? 20000)));

  return server;
}

// ---------- HTTP ----------

function sameToken(given, token) {
  if (!token) return false;
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function reply(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Liga o servidor em 127.0.0.1:port. Resolve com { close } ou rejeita (ex.: porta ocupada).
 * getToken() é lido a cada requisição (gerar um token novo vale na hora).
 * onActivity() é chamado a cada requisição autenticada (indicador "conectado").
 */
function startMcpServer({ port, getToken, api, version, onActivity }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const httpServer = http.createServer(async (req, res) => {
    // Proteções contra páginas web (DNS rebinding / requisição de outro site):
    // só aceita o Host local e nenhuma requisição vinda de navegador (com Origin).
    if (!allowedHosts.has(req.headers.host)) return reply(res, 403, 'Host não permitido');
    if (req.headers.origin) return reply(res, 403, 'Origem não permitida');
    if (new URL(req.url, 'http://x').pathname !== '/mcp') return reply(res, 404, 'Use /mcp');

    const auth = req.headers.authorization ?? '';
    if (!sameToken(auth.startsWith('Bearer ') ? auth.slice(7) : '', getToken())) {
      return reply(res, 401, 'Token inválido. Copie o comando no menu do Multiverse: Contas → Claude Code (MCP).');
    }
    // Sem sessão (stateless): só POST. GET (stream SSE) e DELETE não se aplicam.
    if (req.method !== 'POST') return reply(res, 405, 'Método não permitido');

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400, 'JSON inválido');
    }
    onActivity?.();

    // Um servidor + transporte por requisição: é o modelo recomendado do SDK no modo stateless.
    const server = buildServer(api, version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('MCP:', err);
      if (!res.headersSent) reply(res, 500, 'Erro interno');
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve({ close: () => new Promise((r) => httpServer.close(() => r())) });
    });
  });
}

module.exports = { startMcpServer, ToolError };
