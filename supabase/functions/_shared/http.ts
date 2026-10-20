import type { FetchOptions, HttpClient } from './types.ts';

// Cliente HTTP com timeout e nova tentativa. Nao finge ser navegador: alguns
// sites (wrc.com) bloqueiam User-Agent de navegador falso. Nenhuma fonte usada
// aqui exige driblar protecao anti-robo; se uma passar a exigir, o adaptador
// falha e o motor avisa.
//
// Redirecionamento e seguido a mao (no maximo 3) e so para o mesmo host do
// pedido, um host das fontes conhecidas (SOURCE_HOSTS) ou um host liberado na
// chamada (allowedHosts). Corpo lido aos pedacos, com limite de tamanho.
const USER_AGENT = 'PitStopHubSync/1.0 (+https://pitstophub.vercel.app)';
const TIMEOUT_MS = 20_000;
const RETRIES = 2;
export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// Hosts usados pelos adaptadores (_shared/adapters). Ao adicionar uma fonte,
// incluir o host aqui (tests/http_test.ts confere).
export const SOURCE_HOSTS: ReadonlySet<string> = new Set([
  'api.dtm.com',
  'cba.org.br',
  'cf.nascar.com',
  'drive.google.com',
  'drive.usercontent.google.com',
  'fiawec.alkamelsystems.com',
  'imsa.results.alkamelcloud.com',
  'p-p.redbull.com',
  'porschecupbrasil.com',
  'www.dtm.com',
  'www.f1academy.com',
  'www.fiaformula2.com',
  'www.fiaformula3.com',
  'www.fiawec.com',
  'www.indycar.com',
  'www.nascar.com',
  'www.wrc.com',
]);

export class HttpError extends Error {
  constructor(public status: number, public url: string, message?: string) {
    super(message ?? `HTTP ${status} em ${url}`);
  }
}

export class ResponseTooLargeError extends Error {
  constructor(public url: string, public maxBytes: number) {
    super(`Resposta de ${url} passou do limite de ${maxBytes} bytes; abortado.`);
  }
}

/**
 * URL absoluta do proximo salto de um redirecionamento. Erro se o destino
 * sair do host do pedido original, das fontes conhecidas e de allowedHosts,
 * ou se trocar https por outro protocolo.
 */
export function redirectTarget(current: string, location: string | null, original: string, allowedHosts: Iterable<string> = []): string {
  if (!location) throw new Error(`Redirecionamento sem Location em ${current}`);
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new Error(`Redirecionamento invalido em ${current}: ${location}`);
  }
  const origin = new URL(original);
  if (next.protocol !== 'https:' && next.protocol !== origin.protocol) {
    throw new Error(`Redirecionamento de ${original} para protocolo nao permitido (${next.protocol})`);
  }
  if (next.username || next.password) throw new Error(`Redirecionamento de ${original} com credenciais na URL`);
  const allowed = new Set([origin.host, ...SOURCE_HOSTS, ...[...allowedHosts].map((h) => h.toLowerCase())]);
  if (!allowed.has(next.host)) throw new Error(`Redirecionamento de ${original} para host nao permitido: ${next.host}`);
  return next.href;
}

/** Le o corpo inteiro, abortando se passar de maxBytes. */
export async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new ResponseTooLargeError(url, maxBytes);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Faz o pedido seguindo so os redirecionamentos permitidos. */
async function follow(fetchFn: FetchFn, url: string, init: RequestInit, allowedHosts: string[], signal: AbortSignal): Promise<Response> {
  let current = url;
  let reqInit = init;
  for (let hop = 0;; hop++) {
    const res = await fetchFn(current, {
      ...reqInit,
      headers: { 'user-agent': USER_AGENT, ...(reqInit.headers ?? {}) },
      redirect: 'manual',
      signal,
    });
    if (res.status < 300 || res.status > 399 || res.status === 304) return res;
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new HttpError(res.status, url, `Redirecionamentos demais a partir de ${url}`);
    try {
      current = redirectTarget(current, res.headers.get('location'), url, allowedHosts);
    } catch (error) {
      throw new HttpError(res.status, url, error instanceof Error ? error.message : String(error));
    }
    // Como o fetch faria: 303 (e 301/302 de POST) viram GET sem corpo.
    const method = (reqInit.method ?? 'GET').toUpperCase();
    const toGet = res.status === 303 ? !['GET', 'HEAD'].includes(method) : [301, 302].includes(res.status) && method === 'POST';
    if (toGet) {
      const headers = new Headers(reqInit.headers);
      headers.delete('content-type');
      reqInit = { ...reqInit, method: 'GET', body: undefined, headers: Object.fromEntries(headers) };
    }
  }
}

export interface HttpOptions {
  fetch?: FetchFn;
  /** Espera base entre tentativas (ms). Testes usam 0. */
  retryDelayMs?: number;
}

export function createHttp(options: HttpOptions = {}): HttpClient {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const delay = options.retryDelayMs ?? 1500;

  async function request(url: string, init: RequestInit = {}, opts: FetchOptions = {}): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await follow(fetchFn, url, init, opts.allowedHosts ?? [], AbortSignal.timeout(TIMEOUT_MS));
        if (res.status === 429 || res.status >= 500) {
          lastError = new HttpError(res.status, url);
          await res.body?.cancel();
          await sleep(delay * (attempt + 1));
          continue;
        }
        if (res.headers.get('cf-mitigated') === 'challenge') {
          await res.body?.cancel();
          throw new HttpError(res.status, url, `Bloqueado por desafio anti-robo em ${url}`);
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new HttpError(res.status, url);
        }
        // Le o corpo dentro da tentativa (o timeout vale para a leitura tambem).
        return await readCapped(res, opts.maxBytes ?? DEFAULT_MAX_BYTES, url);
      } catch (error) {
        if (error instanceof ResponseTooLargeError) throw error;
        if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
        lastError = error;
        if (attempt < RETRIES) await sleep(delay * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async text(url, init, opts) {
      return new TextDecoder().decode(await request(url, init, opts));
    },
    async json(url, init, opts) {
      const text = new TextDecoder().decode(await request(url, init, opts));
      return JSON.parse(text.replace(/^﻿/, ''));
    },
    async bytes(url, init, opts) {
      return await request(url, init, opts);
    },
  };
}

export const liveHttp: HttpClient = createHttp();

/** Para testes: responde com arquivos gravados (fixtures) por URL. Respeita maxBytes. */
export function fixtureHttp(files: Record<string, string | Uint8Array>): HttpClient {
  const get = (url: string, opts?: FetchOptions) => {
    const hit = files[url];
    if (hit === undefined) throw new HttpError(404, url, `Sem fixture para ${url}`);
    const bytes = typeof hit === 'string' ? new TextEncoder().encode(hit) : hit;
    if (bytes.byteLength > (opts?.maxBytes ?? DEFAULT_MAX_BYTES)) throw new ResponseTooLargeError(url, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
    return bytes;
  };
  const asText = (v: Uint8Array) => new TextDecoder().decode(v);
  return {
    text: async (url, _init, opts) => asText(get(url, opts)),
    json: async (url, _init, opts) => JSON.parse(asText(get(url, opts)).replace(/^﻿/, '')),
    bytes: async (url, _init, opts) => get(url, opts),
  };
}
