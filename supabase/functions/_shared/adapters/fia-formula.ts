import type { AdapterContext, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow, StandingsSet } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// FIA Formula 2 e Formula 3 pelos sites oficiais (fiaformula2.com /
// fiaformula3.com). Sao Next.js (App Router): os dados vem no payload React
// (flight), pedido com o header "RSC: 1" (text/x-component, metade do HTML).
//   /en/standings/{ano}/drivers -> etapas da temporada (em ordem = rodada),
//                                 total e pontos por corrida (com pole/VMR)
//   /en/standings/{ano}/teams   -> equipes
//   /en/racing/{ano}/{slug}     -> sessoes com horario/estado e a
//                                 classificacao completa SO da ultima corrida
//                                 do fim de semana (normalmente a feature)
// Sem chave de API: o resto das classificacoes so existe via api.formula1.com
// (exige apikey), entao as demais corridas entram so com os pontos de cada
// piloto (sem posicao). O motor usa useSourcePoints.

interface Meeting {
  meetingKey: number | string;
  meetingCountryName: string;
  meetingLocation: string;
  meetingStartDate: string;
  meetingEndDate: string;
  raceSessions: { sessionName: string; description: string; sessionNumber: number }[];
  url: string;
}

interface DriverStanding {
  displayPosition: string;
  championshipPoints: number;
  driverReference: string;
  driverFirstName: string;
  driverLastName: string;
  points: (number | null)[][];
}

interface TeamStanding {
  displayPosition: string;
  championshipPoints: number;
  teamName: string;
}

interface StandingsPayload<T> {
  meetings: Meeting[];
  standings: T[];
  category: string;
}

interface PageResult {
  completionStatusCode: string | null;
  racePoints: number | null;
  version?: string | null;
  positionNumber: string | null;
  lapsCompleted: string | null;
  racingNumber: string | null;
  driverFirstName: string;
  driverLastName: string;
  driverReference: string;
  teamName: string | null;
}

interface PageSession {
  session: string;
  shortName: string;
  sessionType: string;
  sessionNumber: number;
  startTime: string | null;
  gmtOffset: string | null;
  state: string | null;
  results?: PageResult[];
}

interface RacePage {
  meetingOfficialName?: string;
  meetingName?: string;
  circuitOfficialName?: string;
  meetingKey: string | number;
  meetingSessions: PageSession[];
}

// ---------- payload React (flight) ----------

/**
 * Le as linhas do payload flight ("id:JSON"). Aceita a resposta RSC crua ou
 * o HTML (junta os pedacos self.__next_f.push). Linhas de texto "T" sao puladas.
 */
export function flightRows(body: string): unknown[] {
  let text = body;
  if (text.includes('self.__next_f.push')) {
    text = '';
    for (const m of body.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) text += JSON.parse(m[1]);
  }
  const bytes = new TextEncoder().encode(text);
  const dec = new TextDecoder();
  const rows: unknown[] = [];
  let p = 0;
  while (p < bytes.length) {
    let c = p;
    while (c < bytes.length && bytes[c] !== 0x3a && bytes[c] !== 0x0a) c++; // ':'
    if (bytes[c] !== 0x3a) { p = c + 1; continue; }
    c++;
    if (bytes[c] === 0x54) { // 'T<tamanho hex>,<texto>'
      let e = c + 1;
      while (e < bytes.length && bytes[e] !== 0x2c) e++;
      const len = parseInt(dec.decode(bytes.subarray(c + 1, e)), 16);
      if (Number.isFinite(len)) { p = e + 1 + len; continue; }
    }
    let e = c;
    while (e < bytes.length && bytes[e] !== 0x0a) e++;
    const payload = dec.decode(bytes.subarray(c, e));
    if (payload.startsWith('{') || payload.startsWith('[')) {
      try { rows.push(JSON.parse(payload)); } catch { /* linha que nao e JSON (I[...], HL[...]) */ }
    }
    p = e + 1;
  }
  return rows;
}

/** Todos os objetos (em qualquer profundidade) que passam no teste. */
export function findObjects<T>(rows: unknown[], test: (o: Record<string, unknown>) => boolean): T[] {
  const out: T[] = [];
  const stack: unknown[] = [...rows];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (test(o)) out.push(o as T);
      stack.push(...Object.values(o));
    }
  }
  return out;
}

// ---------- utilidades ----------

const PT_NAMES: Record<string, string> = {
  'Miami Gardens': 'Miami',
  'Monte Carlo': 'Mônaco',
  'Montréal': 'Montreal',
  Budapest: 'Budapeste',
  'Yas Marina': 'Abu Dhabi',
  Sakhir: 'Bahrein',
  'Mexico City': 'Cidade do México',
  'São Paulo': 'São Paulo',
  Shanghai: 'Xangai',
};

const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "Sprint Race" -> sprint, "Feature Race 2" -> feature2. */
export function sessionKey(description: string, number: number): string {
  const d = description.toLowerCase();
  const n = d.match(/\b(\d)\b/)?.[1] ?? '';
  if (d.includes('sprint')) return `sprint${n}`;
  if (d.includes('feature')) return `feature${n}`;
  return `race${number}`;
}

const isFeature = (description: string) => /feature/i.test(description);
const fullName = (first: string, last: string) => `${first} ${last}`.replace(/\s+/g, ' ').trim();

function utc(start: string | null, offset: string | null): string | null {
  if (!start) return null;
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(start) ? start : `${start}${offset ?? 'Z'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('.000Z', 'Z');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const RSC = { headers: { RSC: '1' } };

async function standings<T>(ctx: AdapterContext, base: string, season: number, kind: 'drivers' | 'teams'): Promise<StandingsPayload<T>> {
  const url = `${base}/en/standings/${season}/${kind}`;
  const rows = flightRows(await ctx.http.text(url, RSC));
  const found = findObjects<StandingsPayload<T>>(rows, (o) => Array.isArray(o.meetings) && Array.isArray(o.standings));
  if (!found.length) throw new Error(`Classificacao nao encontrada no payload de ${url}; o site mudou?`);
  return found[0];
}

/**
 * URL de um caminho que veio da fonte (m.url), montada sobre o site da serie.
 * Erro se apontar para outro site (URL absoluta, "//host", outro esquema).
 */
export function sameOriginUrl(path: string, base: string): string {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error(`Link fora de ${new URL(base).host}: ${path}`);
  return url.href;
}

async function racePage(ctx: AdapterContext, base: string, path: string): Promise<RacePage> {
  const url = sameOriginUrl(path, base);
  const rows = flightRows(await ctx.http.text(url, RSC));
  const found = findObjects<RacePage>(rows, (o) => Array.isArray(o.meetingSessions) && 'meetingKey' in o);
  if (!found.length) throw new Error(`Sessoes nao encontradas no payload de ${url}.`);
  return found[0];
}

// ---------- adaptador ----------

interface Series {
  id: string;
  label: string;
  base: string;
  sprint: number[];
}

function makeAdapter(series: Series): AdapterWithRules {
  const feature = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
  return {
    id: series.id,
    source: series.base.replace('https://www.', ''),
    staleAfterHours: 24,
    rules: {
      // Tabelas de referencia; pole (+2) e volta mais rapida (+1, top 10) e
      // corridas com meia pontuacao vem nos pontos da propria fonte.
      2026: { sessions: { sprint: series.sprint, feature, feature1: feature, feature2: feature }, useSourcePoints: true },
    },

    // Sem lista de temporadas: testa o ano atual e o seguinte (a pagina de
    // classificacao de um ano sem calendario volta com "meetings" vazio).
    async listSeasons(ctx) {
      const year = ctx.now.getUTCFullYear();
      const out: number[] = [];
      for (const y of [year, year + 1]) {
        const data = await standings<DriverStanding>(ctx, series.base, y, 'drivers').catch(() => null);
        if (data?.meetings.length) out.push(y);
      }
      return out;
    },

    async fetchSnapshot(ctx, season): Promise<Snapshot> {
      const notes: string[] = [];
      const [drivers, teams] = await Promise.all([
        standings<DriverStanding>(ctx, series.base, season, 'drivers'),
        standings<TeamStanding>(ctx, series.base, season, 'teams').catch((e) => {
          notes.push(`Classificacao de equipes indisponivel: ${e instanceof Error ? e.message : e}`);
          return null;
        }),
      ]);
      const meetings = drivers.meetings;
      if (!meetings.length) throw new Error(`${series.label}: temporada ${season} sem etapas na fonte.`);

      // Pagina de cada etapa (horarios, estado, ultima classificacao). Falha
      // numa etapa nao derruba as outras: cai nas datas da classificacao.
      const pages = await mapLimit(meetings, 4, (m) =>
        racePage(ctx, series.base, m.url).catch((e) => {
          notes.push(`${m.meetingLocation}: pagina da etapa falhou (${e instanceof Error ? e.message : e}).`);
          return null;
        })
      );

      const teamOf = new Map<string, string>();
      const races: RaceRecord[] = [];
      const results: RaceResult[] = [];

      meetings.forEach((m, i) => {
        const round = i + 1;
        const location = m.meetingLocation.trim();
        const raceId = `r${String(round).padStart(2, '0')}-${m.url.split('/').filter(Boolean).at(-1) ?? slug(location)}`;
        const page = pages[i];
        const pageRaces = (page?.meetingSessions ?? []).filter((s) => /race/i.test(s.sessionType));
        const pageSession = (n: number) => pageRaces.find((s) => s.sessionNumber === n);

        // Pontos por corrida: points[i][k] segue m.raceSessions[k].
        const pointsAt = (k: number) =>
          drivers.standings.map((d) => ({ d, pts: d.points?.[i]?.[k] ?? null })).filter((x) => x.pts != null) as { d: DriverStanding; pts: number }[];
        const sessionsDone = m.raceSessions.map((s, k) => {
          const state = pageSession(s.sessionNumber)?.state;
          return state ? state === 'completed' : pointsAt(k).length > 0;
        });

        const features = m.raceSessions.filter((s) => isFeature(s.description));
        const main = features.at(-1) ?? m.raceSessions.at(-1);
        const mainPage = main ? pageSession(main.sessionNumber) : undefined;
        const allCancelled = pageRaces.length > 0 && pageRaces.every((s) => /cancel/i.test(s.state ?? ''));
        const status: RaceRecord['status'] = allCancelled ? 'cancelled' : sessionsDone.length && sessionsDone.every(Boolean) ? 'completed' : 'upcoming';

        // Vencedor = vencedor da (ultima) feature. Primeiro pela classificacao
        // completa da pagina; senao pelos pontos: so o vencedor chega a 25
        // (2o no maximo 18+2+1). Com meia pontuacao fica sem vencedor.
        let winner: string | null = null;
        let official = true;
        if (status === 'completed' && main) {
          const first = mainPage?.results?.find((r) => r.positionNumber === '1');
          if (first) {
            winner = fullName(first.driverFirstName, first.driverLastName);
            official = !/provisional/i.test(first.version ?? '');
          } else {
            const k = m.raceSessions.indexOf(main);
            const top = pointsAt(k).filter((x) => x.pts >= 25);
            if (top.length === 1) winner = fullName(top[0].d.driverFirstName, top[0].d.driverLastName);
            else notes.push(`${location}: vencedor da ${main.description} nao identificado pelos pontos.`);
          }
        }

        const pt = PT_NAMES[location] ?? location;
        races.push({
          raceId,
          round,
          name: pt,
          enName: page?.meetingOfficialName ?? page?.meetingName ?? `${location}, ${m.meetingCountryName}`,
          location: pt,
          enLocation: `${location}, ${m.meetingCountryName}`,
          circuit: page?.circuitOfficialName ?? null,
          date: mainPage?.startTime?.slice(0, 10) ?? m.meetingEndDate,
          startsAt: utc(mainPage?.startTime ?? null, mainPage?.gmtOffset ?? null),
          status,
          winner,
          official,
          externalId: String(m.meetingKey),
          sourceUrl: safeSourceUrl(m.url, series.base),
        });

        // Resultados das corridas ja disputadas (futuras nao tem pontos).
        m.raceSessions.forEach((s, k) => {
          const scored = pointsAt(k);
          if (!scored.length) return;
          const ps = pageSession(s.sessionNumber);
          const byRef = new Map(scored.map((x) => [x.d.driverReference, x.pts]));
          let rows: ResultRow[];
          let isOfficial = true;
          if (ps?.results?.length) {
            rows = ps.results.map((r) => {
              const pos = Number(r.positionNumber);
              const classified = r.completionStatusCode === 'OK' && Number.isInteger(pos) && pos > 0 && pos < 100;
              if (r.teamName) teamOf.set(r.driverReference, r.teamName);
              return {
                position: classified ? pos : null,
                driver: fullName(r.driverFirstName, r.driverLastName),
                team: r.teamName ?? null,
                number: r.racingNumber ?? null,
                status: classified ? null : r.completionStatusCode ?? null,
                laps: r.lapsCompleted != null ? Number(r.lapsCompleted) : null,
                points: byRef.get(r.driverReference) ?? r.racePoints ?? 0,
              };
            });
            const seen = new Set(ps.results.map((r) => r.driverReference));
            for (const x of scored) {
              if (x.pts && !seen.has(x.d.driverReference)) rows.push({ position: null, driver: fullName(x.d.driverFirstName, x.d.driverLastName), points: x.pts });
            }
            isOfficial = !ps.results.some((r) => /provisional/i.test(r.version ?? ''));
          } else {
            rows = scored
              .filter((x) => x.pts > 0)
              .sort((a, b) => b.pts - a.pts)
              .map((x) => ({ position: null, driver: fullName(x.d.driverFirstName, x.d.driverLastName), points: x.pts }));
          }
          results.push({ raceId, session: sessionKey(s.description, s.sessionNumber), official: isOfficial, rows });
        });
      });

      const partial = results.filter((r) => r.rows.every((x) => x.position == null)).length;
      if (partial) notes.push(`${partial} corrida(s) so com os pontos de cada piloto (sem posicao): a fonte publica sem chave so a classificacao da ultima corrida de cada etapa.`);

      const asOfRound = Math.max(0, ...races.filter((r) => results.some((x) => x.raceId === r.raceId)).map((r) => r.round)) || null;
      const driverRows: StandingRow[] = drivers.standings.map((d) => ({
        position: Number(d.displayPosition),
        name: fullName(d.driverFirstName, d.driverLastName),
        team: teamOf.get(d.driverReference) ?? null,
        points: d.championshipPoints,
      }));
      const officialStandings: StandingsSet[] = [{ group: 'drivers', rows: fixPositions(driverRows, notes, 'drivers'), asOfRound }];
      if (teams?.standings.length) {
        const rows = teams.standings.map((t) => ({ position: Number(t.displayPosition), name: t.teamName.trim(), points: t.championshipPoints }));
        officialStandings.push({ group: 'teams', rows: fixPositions(rows, notes, 'teams'), asOfRound });
      }
      return { season, races, results, officialStandings, notes };
    },
  };
}

/** Mesmo teste de sameOriginUrl; link fora do site vira null (nao vai para o banco). */
function safeSourceUrl(path: string, base: string): string | null {
  try {
    return sameOriginUrl(path, base);
  } catch {
    return null;
  }
}

/**
 * displayPosition vazio, nao numerico ou maior que a lista (a fonte pula
 * posicoes de piloto omitido, ex.: F3 2026 vai de 33 para 35) -> pela ordem.
 */
function fixPositions(rows: StandingRow[], notes: string[], group: string): StandingRow[] {
  let fixed = 0;
  const out = rows.map((r, i) => {
    if (Number.isInteger(r.position) && r.position > 0 && r.position <= rows.length) return r;
    fixed++;
    return { ...r, position: i + 1 };
  });
  if (fixed) notes.push(`Classificacao (${group}): ${fixed} posicao(oes) fora da sequencia renumerada(s) pela ordem da fonte.`);
  return out;
}

export const f2 = makeAdapter({
  id: 'f2',
  label: 'Formula 2',
  base: 'https://www.fiaformula2.com',
  sprint: [10, 8, 6, 5, 4, 3, 2, 1],
});

export const f3 = makeAdapter({
  id: 'f3',
  label: 'Formula 3',
  base: 'https://www.fiaformula3.com',
  sprint: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
});
