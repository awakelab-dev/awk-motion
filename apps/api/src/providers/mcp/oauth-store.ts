import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/**
 * Proveedor OAuth (authorization code + PKCE + registro dinámico) para el servidor MCP de
 * Higgsfield. Persiste cliente y tokens en un archivo local con permisos 600.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  /** URL de autorización pendiente, para mostrarla en la UI. */
  pendingAuthUrl?: string;

  constructor(
    private file: string,
    private callbackUrl: string,
  ) {}

  private read(): Stored {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Stored;
    } catch {
      return {};
    }
  }

  private write(patch: Partial<Stored>) {
    mkdirSync(dirname(this.file), { recursive: true });
    const next = { ...this.read(), ...patch };
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* no crítico */
    }
  }

  get redirectUrl() {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Wilox Motion (local)',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid email offline_access',
    };
  }

  clientInformation() {
    return this.read().client;
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    this.write({ client: info });
  }

  tokens() {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.write({ tokens });
    this.pendingAuthUrl = undefined;
  }

  redirectToAuthorization(url: URL) {
    this.pendingAuthUrl = url.toString();
  }

  saveCodeVerifier(v: string) {
    this.write({ verifier: v });
  }

  codeVerifier() {
    const v = this.read().verifier;
    if (!v) throw new Error('No hay code_verifier guardado; vuelve a iniciar la conexión con Higgsfield.');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const s = this.read();
    if (scope === 'all') this.write({ client: undefined, tokens: undefined, verifier: undefined });
    else if (scope === 'client') this.write({ ...s, client: undefined });
    else if (scope === 'tokens') this.write({ ...s, tokens: undefined });
    else if (scope === 'verifier') this.write({ ...s, verifier: undefined });
  }
}
