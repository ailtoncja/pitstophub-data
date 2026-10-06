// Helpers compartilhados entre o sync completo (sync-thesportsdb.mjs, 1x/dia,
// reconstroi o calendario inteiro das 9 categorias) e o checador rapido de
// resultados (check-recent-results.mjs, a cada poucos minutos, so re-consulta
// corridas especificas). Centralizado aqui pra status/vencedor nunca serem
// calculados de dois jeitos diferentes entre os dois scripts.

export const REQUEST_DELAY_MS = 700; // ~85 req/min, folga sob o limite Premium de 100/min

// "123" e a chave publica de teste da propria TheSportsDB (sem cadastro, sem
// custo). Se a chave paga parar de responder por qualquer motivo (endpoint
// descontinuado, assinatura vencida, chave revogada), fetchJson tenta de novo
// com essa chave antes de desistir -- degrada pro nivel gratuito em vez de
// parar de sincronizar.
export const FALLBACK_API_BASE = 'https://www.thesportsdb.com/api/v1/json/123';

export function apiBaseFor(apiKey) {
  return `https://www.thesportsdb.com/api/v1/json/${apiKey}`;
}

export async function fetchJson(apiBase, path) {
  try {
    return await fetchFrom(apiBase, path);
  } catch (primaryError) {
    console.warn(`[fallback] chave paga falhou em ${path} (${primaryError.message}) - tentando chave publica de teste`);
    try {
      return await fetchFrom(FALLBACK_API_BASE, path);
    } catch {
      throw primaryError; // erro da chave paga e mais util pro resumo final
    }
  }
}

async function fetchFrom(base, path, attempt = 0) {
  const res = await fetch(`${base}${path}`);
  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await sleep(3000 * (attempt + 1));
    return fetchFrom(base, path, attempt + 1);
  }
  if (!res.ok) throw new Error(`TheSportsDB HTTP ${res.status} em ${path}`);
  return res.json();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getStatus(event) {
  if (event.strPostponed === 'yes') return 'cancelled';
  if (event.strStatus === 'FT' || (event.strResult && event.strResult.trim().length > 0)) return 'completed';
  if (event.dateEvent && new Date(`${event.dateEvent}T23:59:59Z`) < new Date()) return 'completed';
  return 'upcoming';
}

// O texto de resultado da TheSportsDB nao segue um formato unico entre ligas
// (F2/F3/DTM/IndyCar usam "posicao\t/piloto\t/equipe\t/tempo", NASCAR usa os
// mesmos campos sem a barra e as vezes com uma linha de cabecalho antes dos
// dados, WEC usa "posicao /equipe #carro /tempo" sem tabs). IMSA e GT World
// Challenge usam texto corrido em prosa (varia a cada corrida) - nunca da pra
// extrair com seguranca, entao essas linhas nunca batem com o padrao abaixo e
// o vencedor fica em branco de propósito. Percorremos as linhas ate achar uma
// que bata exatamente com "posicao 1"; caso contrario preferimos deixar em
// branco a arriscar um nome errado.
export function parseWinner(strResult) {
  if (!strResult) return null;
  const lines = strResult.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const fields = splitResultFields(line);
    if (fields.length < 2) continue;

    const position = fields[0].replace(/^0+(?=\d)/, '');
    if (position !== '1') continue;

    const name = fields.slice(1).find((f) => /[a-zA-Z]{3,}/.test(f) && !/^[\d:.+\s]+$/.test(f));
    if (name) return name;
  }

  return null;
}

function splitResultFields(line) {
  const raw = line.includes('\t') ? line.split('\t') : line.split('/');
  return raw.map((f) => f.replace(/^\//, '').trim()).filter(Boolean);
}
