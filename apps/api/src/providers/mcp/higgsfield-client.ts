import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { FileOAuthProvider } from './oauth-store.js';

export interface HiggsfieldStatus {
  connected: boolean;
  authUrl?: string;
  error?: string;
}

/**
 * Cliente MCP directo al conector de Higgsfield. El backend llama a las herramientas de forma
 * determinista (generate_*_batch, jobs_wait, sandbox_exec…); Opus no interviene aquí.
 */
export class HiggsfieldClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<void>;
  private lastError?: string;
  readonly auth: FileOAuthProvider;

  constructor(
    private url: string,
    tokenFile: string,
    callbackUrl: string,
  ) {
    this.auth = new FileOAuthProvider(tokenFile, callbackUrl);
  }

  status(): HiggsfieldStatus {
    return { connected: !!this.client, authUrl: this.auth.pendingAuthUrl, error: this.client ? undefined : this.lastError };
  }

  /** Conecta; si falta autorización deja `authUrl` listo para abrir en el navegador. */
  connect(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => (this.connecting = undefined));
    }
    return this.connecting;
  }

  private async doConnect() {
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), { authProvider: this.auth });
    const client = new Client({ name: 'wilox-motion', version: '0.1.0' });
    try {
      await client.connect(this.transport);
      this.client = client;
      this.lastError = undefined;
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        this.lastError = 'Falta autorizar Higgsfield: abre el enlace de conexión.';
      } else {
        this.lastError = (e as Error).message;
        throw e;
      }
    }
  }

  /** Completa el OAuth con el código recibido en el callback y reconecta. */
  async finishAuth(code: string) {
    if (!this.transport) this.transport = new StreamableHTTPClientTransport(new URL(this.url), { authProvider: this.auth });
    await this.transport.finishAuth(code);
    this.client = undefined;
    this.auth.pendingAuthUrl = undefined;
    await this.doConnect();
    if (!this.client) throw new Error(this.lastError ?? 'No se pudo conectar con Higgsfield tras autorizar.');
  }

  /** Llama a una herramienta y devuelve su resultado JSON. */
  async call<T = unknown>(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    await this.connect();
    if (!this.client) throw new Error(this.lastError ?? 'Higgsfield no está conectado.');
    let res;
    try {
      res = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true });
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        this.client = undefined;
        await this.connect();
        throw new Error('La sesión de Higgsfield expiró: vuelve a conectar desde la app.');
      }
      throw e;
    }
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
    if (res.isError) throw new Error(`Higgsfield ${name}: ${text.slice(0, 1500)}`);
    if (res.structuredContent) return res.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Algunas herramientas devuelven JSON seguido de texto: se toma el primer objeto.
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]) as T;
        } catch {
          /* sigue */
        }
      }
      return text as unknown as T;
    }
  }
}
