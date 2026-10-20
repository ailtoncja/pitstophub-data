import type { HttpClient } from './types.ts';

// Cliente HTTP com timeout e nova tentativa. Nao finge ser navegador: alguns
// sites (wrc.com) bloqueiam User-Agent de navegador falso. Nenhuma fonte usada
// aqui exige driblar protecao anti-robo; se uma passar a exigir, o adaptador
// falha e o motor avisa.
const USER_AGENT = 'PitStopHubSync/1.0 (+https://pitstophub.vercel.app)';
const TIMEOUT_MS = 20_000;
const RETRIES = 2;

export class HttpError extends Error {
  constructor(public status: number, public url: string, message?: string) {
    super(message ?? `HTTP ${status} em ${url}`);
  }
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': USER_AGENT, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url);
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
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
      return res;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      lastError = error;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export const liveHttp: HttpClient = {
  async text(url, init) {
    return await (await request(url, init)).text();
  },
  async json(url, init) {
    const text = await (await request(url, init)).text();
    return JSON.parse(text.replace(/^﻿/, ''));
  },
  async bytes(url, init) {
    return new Uint8Array(await (await request(url, init)).arrayBuffer());
  },
};

/** Para testes: responde com arquivos gravados (fixtures) por URL. */
export function fixtureHttp(files: Record<string, string | Uint8Array>): HttpClient {
  const get = (url: string) => {
    const hit = files[url];
    if (hit === undefined) throw new HttpError(404, url, `Sem fixture para ${url}`);
    return hit;
  };
  const asText = (v: string | Uint8Array) => (typeof v === 'string' ? v : new TextDecoder().decode(v));
  return {
    text: async (url) => asText(get(url)),
    json: async (url) => JSON.parse(asText(get(url)).replace(/^﻿/, '')),
    bytes: async (url) => {
      const v = get(url);
      return typeof v === 'string' ? new TextEncoder().encode(v) : v;
    },
  };
}
