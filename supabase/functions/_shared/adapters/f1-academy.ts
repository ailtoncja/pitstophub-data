import type { AdapterContext, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow, StandingsSet } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// F1 Academy pelo site oficial (f1academy.com). As paginas sao Next.js e
// trazem os dados limpos em <script id="__NEXT_DATA__">:
//   Calendar?seasonid=N        -> etapas, sessoes, horarios e vencedores
//   Results?raceid=N           -> classificacao de cada sessao (sem pontos)
//   Standings/Driver?seasonId=N -> total e pontos por corrida (com bonus)
// A volta mais rapida nao vem marcada no resultado, entao os pontos de cada
// corrida saem da tabela oficial (RacePoints) e o motor usa useSourcePoints.

const BASE = 'https://www.f1academy.com/Racing-Series';

interface FaSession {
  SessionId: number;
  SessionCode: string;
  SessionName: string;
  SessionStartTime: string | null;
  SessionResultsAvailable: boolean;
  NoClassification?: boolean;
  WinnerFullName?: string | null;
}

interface FaRace {
  RaceId: number;
  RoundNumber: number;
  RaceStartDate: string;
  RaceEndDate: string;
  CircuitName: string;
  CircuitShortName: string;
  CountryName: string;
  State: string;
  Sessions: FaSession[];
}

interface FaSeason {
  SeasonId: number;
  SeasonName: string;
}

interface FaCalendar {
  seasonData: FaSeason[];
  pageData: { SeasonId: number; SeasonName: string; Races: FaRace[] };
}

interface FaResultRow {
  DriverId: number;
  FinishPosition: number | null;
  DriverForename: string;
  DriverSurname: string;
  TeamName: string | null;
  CarNumber: number | null;
  LapsCompleted: number | null;
  ResultStatus: string | null;
  DisplayFinishPosition?: string | null;
}

interface FaSessionResult {
  SessionId: number;
  SessionType: string;
  ResultsAreOfficial: boolean;
  Results: FaResultRow[] | null;
}

interface FaStandingsRow {
  Position: number;
  DriverID?: number;
  TeamID?: number;
  FullName: string;
  TeamName?: string | null;
  TotalPoints: number;
  RacePoints: (number | null)[][];
}

interface FaStandings {
  SeasonId: number;
  SeasonRaces: { RaceId: number; Sessions: { SessionId: number }[] }[];
  Standings: FaStandingsRow[];
}

// Nome curto em portugues quando difere do original.
const PT_NAMES: Record<string, string> = {
  Shanghai: 'Xangai',
  'Mexico City': 'Cidade do México',
  'Sao Paulo': 'São Paulo',
  'Miami Gardens': 'Miami',
  'Monte Carlo': 'Mônaco',
  'Yas Marina': 'Abu Dhabi',
  Budapest: 'Budapeste',
};

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "Alisha  Palmowski", "Chiara Bättig (WCD)" -> nome limpo (WCD = wildcard). */
export function cleanName(name: string): string {
  return name.replace(/\(WCD\)/gi, '').replace(/\s+/g, ' ').trim();
}

/** Chave da sessao que pontua: Feature Race -> feature, Reverse Grid Race -> reverse... */
export function sessionKey(name: string): string {
  if (/feature/i.test(name)) return 'feature';
  if (/reverse/i.test(name)) return 'reverse';
  if (/opening/i.test(name)) return 'opening';
  return slug(name.replace(/\brace\b/i, '')) || 'race';
}

const toUtc = (local: string | null) => (local ? new Date(local).toISOString().replace('.000Z', 'Z') : null);

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

/** Le o JSON do __NEXT_DATA__ e devolve props.pageProps. */
export function nextData<T>(html: string, url: string): T {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`F1 Academy: pagina sem __NEXT_DATA__ (${url}); o site mudou?`);
  const props = JSON.parse(m[1])?.props?.pageProps;
  if (!props?.pageData) throw new Error(`F1 Academy: __NEXT_DATA__ sem pageData (${url}).`);
  return props as T;
}

async function page<T>(ctx: AdapterContext, url: string): Promise<T> {
  return nextData<T>(await ctx.http.text(url), url);
}

const yearOf = (s: FaSeason) => Number(s.SeasonName.match(/\b(20\d\d)\b/)?.[1]);

async function calendarFor(ctx: AdapterContext, season: number): Promise<FaCalendar> {
  const current = await page<FaCalendar>(ctx, `${BASE}/Calendar`);
  const found = current.seasonData.find((s) => yearOf(s) === season);
  if (!found) throw new Error(`F1 Academy: temporada ${season} nao aparece na lista do site.`);
  if (found.SeasonId === current.pageData.SeasonId) return current;
  return await page<FaCalendar>(ctx, `${BASE}/Calendar?seasonid=${found.SeasonId}`);
}

const pointSessions = (race: FaRace) => race.Sessions.filter((s) => s.SessionCode === 'RESULT');
const mainSession = (race: FaRace) => {
  const list = pointSessions(race);
  return list.find((s) => /feature/i.test(s.SessionName)) ?? list.at(-1) ?? null;
};

function raceStatus(race: FaRace): RaceRecord['status'] {
  if (/cancel/i.test(race.State)) return 'cancelled';
  const main = mainSession(race);
  return main?.SessionResultsAvailable ? 'completed' : 'upcoming';
}

function standingsSet(group: string, data: FaStandings, asOfRound: number | null): StandingsSet {
  const n = data.Standings.length;
  const rows: StandingRow[] = data.Standings.map((r, i) => ({
    // Posicao fora da sequencia (piloto omitido) -> pela ordem da fonte.
    position: Number.isInteger(r.Position) && r.Position > 0 && r.Position <= n ? r.Position : i + 1,
    name: cleanName(r.FullName),
    team: r.TeamName ? r.TeamName.trim() : null,
    points: r.TotalPoints,
  }));
  return { group, rows, asOfRound };
}

export const adapter: AdapterWithRules = {
  id: 'f1-academy',
  source: 'f1academy.com',
  staleAfterHours: 24,

  rules: {
    // Pontos por sessao (referencia). Pole +2 e volta mais rapida +1 (top 10)
    // entram pelos pontos da propria fonte (useSourcePoints).
    2026: {
      sessions: {
        opening: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
        reverse: [10, 8, 6, 5, 4, 3, 2, 1],
        feature: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
      },
      useSourcePoints: true,
    },
  },

  async listSeasons(ctx) {
    const cal = await page<FaCalendar>(ctx, `${BASE}/Calendar`);
    const shown = yearOf({ SeasonId: 0, SeasonName: cal.pageData.SeasonName });
    const out: number[] = [];
    for (const s of cal.seasonData) {
      const year = yearOf(s);
      if (!Number.isInteger(year)) continue;
      if (year > shown) {
        // Temporada nova listada: so conta se ja tem calendario.
        const next = await page<FaCalendar>(ctx, `${BASE}/Calendar?seasonid=${s.SeasonId}`).catch(() => null);
        if (!next?.pageData.Races?.length) continue;
      }
      out.push(year);
    }
    return out.sort((a, b) => a - b);
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const cal = await calendarFor(ctx, season);
    const seasonId = cal.pageData.SeasonId;
    const racesSrc = [...cal.pageData.Races].sort((a, b) => a.RoundNumber - b.RoundNumber);
    if (!racesSrc.length) throw new Error(`F1 Academy: calendario ${season} vazio.`);

    const [drivers, teams] = await Promise.all([
      page<{ pageData: FaStandings }>(ctx, `${BASE}/Standings/Driver?seasonId=${seasonId}`),
      page<{ pageData: FaStandings }>(ctx, `${BASE}/Standings/Team?seasonId=${seasonId}`).catch((e) => {
        notes.push(`Classificacao de equipes indisponivel: ${e instanceof Error ? e.message : e}`);
        return null;
      }),
    ]);
    if (drivers.pageData.SeasonId !== seasonId) {
      throw new Error(`F1 Academy: classificacao veio da temporada ${drivers.pageData.SeasonId}, esperada ${seasonId}.`);
    }

    // SessionId -> DriverId -> pontos (com bonus), na ordem de SeasonRaces/Sessions.
    const pointsBySession = new Map<number, Map<number, number>>();
    for (const row of drivers.pageData.Standings) {
      drivers.pageData.SeasonRaces.forEach((race, i) => {
        race.Sessions.forEach((s, k) => {
          const pts = row.RacePoints?.[i]?.[k];
          if (pts == null || row.DriverID == null) return;
          if (!pointsBySession.has(s.SessionId)) pointsBySession.set(s.SessionId, new Map());
          pointsBySession.get(s.SessionId)!.set(row.DriverID, pts);
        });
      });
    }

    // Resultados so das etapas com alguma corrida ja classificada.
    const withResults = racesSrc.filter((r) => pointSessions(r).some((s) => s.SessionResultsAvailable));
    const resultPages = await mapLimit(withResults, 4, async (r) => {
      const data = await page<{ pageData: { SessionResults: FaSessionResult[] } }>(ctx, `${BASE}/Results?raceid=${r.RaceId}`);
      return [r.RaceId, data.pageData.SessionResults ?? []] as const;
    });
    const sessionsByRace = new Map(resultPages);

    const races: RaceRecord[] = [];
    const results: RaceResult[] = [];
    for (const r of racesSrc) {
      const round = r.RoundNumber;
      const raceId = `r${String(round).padStart(2, '0')}-${slug(r.CircuitShortName)}`;
      const main = mainSession(r);
      const status = raceStatus(r);
      const sessionResults = sessionsByRace.get(r.RaceId) ?? [];
      const mainResult = main ? sessionResults.find((s) => s.SessionId === main.SessionId) : undefined;

      let winner: string | null = null;
      if (status === 'completed') {
        const first = mainResult?.Results?.find((x) => x.FinishPosition === 1);
        winner = main?.WinnerFullName ? cleanName(main.WinnerFullName) : first ? cleanName(`${first.DriverForename} ${first.DriverSurname}`) : null;
      }

      races.push({
        raceId,
        round,
        name: PT_NAMES[r.CircuitShortName.trim()] ?? r.CircuitShortName.trim(),
        enName: `${r.CircuitShortName.trim()}, ${r.CountryName.trim()}`,
        location: PT_NAMES[r.CircuitShortName.trim()] ?? r.CircuitShortName.trim(),
        enLocation: `${r.CircuitShortName.trim()}, ${r.CountryName.trim()}`,
        circuit: r.CircuitName.trim(),
        date: main?.SessionStartTime?.slice(0, 10) ?? r.RaceEndDate,
        startsAt: toUtc(main?.SessionStartTime ?? null),
        status,
        winner,
        official: mainResult ? mainResult.ResultsAreOfficial !== false : true,
        externalId: String(r.RaceId),
        sourceUrl: `${BASE}/Results?raceid=${r.RaceId}`,
      });

      if (status !== 'completed' && !sessionResults.length) continue;
      for (const s of pointSessions(r)) {
        if (!s.SessionResultsAvailable) continue;
        const sr = sessionResults.find((x) => x.SessionId === s.SessionId);
        const pts = pointsBySession.get(s.SessionId);
        if (!pts) notes.push(`${r.CircuitShortName}: ${s.SessionName} ainda sem pontos na classificacao oficial.`);
        const rows: ResultRow[] = (sr?.Results ?? []).map((x) => ({
          position: x.FinishPosition ?? null,
          driver: cleanName(`${x.DriverForename} ${x.DriverSurname}`),
          team: x.TeamName?.trim() || null,
          number: x.CarNumber != null ? String(x.CarNumber) : null,
          status: x.ResultStatus ?? (x.FinishPosition == null ? x.DisplayFinishPosition ?? null : null),
          laps: x.LapsCompleted ?? null,
          points: pts?.get(x.DriverId) ?? 0,
        }));
        // Pontuou na tabela mas nao aparece no resultado: entra sem posicao.
        const seen = new Set((sr?.Results ?? []).map((x) => x.DriverId));
        for (const st of drivers.pageData.Standings) {
          const p = st.DriverID != null ? pts?.get(st.DriverID) : undefined;
          if (p && !seen.has(st.DriverID!)) rows.push({ position: null, driver: cleanName(st.FullName), team: st.TeamName ?? null, points: p });
        }
        if (!rows.length) {
          notes.push(`${r.CircuitShortName}: ${s.SessionName} sem classificacao na fonte.`);
          continue;
        }
        results.push({ raceId, session: sessionKey(s.SessionName), official: sr?.ResultsAreOfficial !== false, rows });
      }
    }

    const asOfRound = Math.max(0, ...races.filter((r) => results.some((x) => x.raceId === r.raceId)).map((r) => r.round)) || null;
    const officialStandings = [standingsSet('drivers', drivers.pageData, asOfRound)];
    if (teams?.pageData.SeasonId === seasonId && teams.pageData.Standings?.length) officialStandings.push(standingsSet('teams', teams.pageData, asOfRound));

    return { season, races, results, officialStandings, notes };
  },
};
