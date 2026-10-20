import type { AdapterContext, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow, StandingsSet } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// DTM pela API publica do site oficial (api.dtm.com, a mesma que o dtm.com usa).
//
// - Calendario: query=events (todas as temporadas, inclusive a seguinte ja
//   anunciada). Temporada = ano do evento com raceSeries "DTM".
// - Resultados: query=wigeResults (um registro por sessao; jsonText e um JSON
//   dentro de string). As linhas de corrida trazem racepoints, qualifyingpoints
//   (pontos do quali daquele dia: 3-2-1) e fastestlappoints.
// - Classificacao: query=wigeStandings (pilotos, equipes e fabricantes).
//
// Um RaceRecord por fim de semana (rodada). Como o app so tem um campo de
// vencedor por rodada, winner = "Vencedor Corrida 1 / Vencedor Corrida 2"
// quando sao pilotos diferentes, ou um nome so quando o mesmo venceu as duas.
// Resultados: uma RaceResult por sessao que pontua (race1, race2,
// qualifying1, qualifying2) com os pontos da propria fonte.

const BASE = 'https://api.dtm.com/data';
const SERIES = 'DTM';
const TZ = 'Europe/Berlin';
// A fonte marca TODAS as sessoes como "provisional", ate as de abril. So
// tratamos como provisorio o que terminou ha menos de 7 dias.
const PROVISIONAL_DAYS = 7;

interface ApiEvent {
  name: string;
  slug: string;
  startTime: string;
  endTime: string;
  eventNumber: number;
  raceSeries?: string[];
  country?: { countryCode?: string; name?: string } | null;
  racetrack?: { name?: string } | null;
}

interface ApiSession {
  sessionid: string;
  type: string;
  name: string;
  timeStart?: string;
}

interface ApiRow {
  position: number | null;
  number?: string;
  name: string;
  team?: string;
  laps?: number | null;
  status?: string;
  racepoints?: string | null;
  qualifyingpoints?: string | null;
  fastestlappoints?: string | null;
  totalpoints?: string | null;
}

interface ApiResultDoc {
  sessionid: string;
  sessions: ApiSession[];
  result: ApiRow[];
  provision?: string;
}

interface ApiStandingRow {
  name: string;
  position: number;
  totalpoints: string;
}

const COUNTRY_PT: Record<string, string> = {
  Germany: 'Alemanha',
  Austria: 'Áustria',
  Netherlands: 'Holanda',
  Belgium: 'Bélgica',
  Italy: 'Itália',
  Portugal: 'Portugal',
  Spain: 'Espanha',
  France: 'França',
  Hungary: 'Hungria',
  'Czech Republic': 'República Tcheca',
};

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "Red Bull Ring by VKB-Bank" -> "Red Bull Ring"; "Motorsport Arena Oschersleben" -> "Oschersleben". */
export function shortEventName(name: string): string {
  return name
    .replace(/\s+(powered|presented)\s+by\s+.*$/i, '')
    .replace(/\s+by\s+.*$/i, '')
    .replace(/^(Motorsport Arena|Circuit|Dekra|DEKRA|Autodromo|TT Circuit)\s+/i, '')
    .trim();
}

const PARTICLES = new Set(['van', 'der', 'den', 'de', 'von', 'di', 'da', 'dos', 'du', 'le', 'la', 'ten', 'zu']);

/** "PREINING Thomas" -> "Thomas Preining"; "VAN DER LINDE Kelvin" -> "Kelvin van der Linde". */
export function driverName(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  const isUpper = (w: string) => w === w.toLocaleUpperCase() && w !== w.toLocaleLowerCase();
  let cut = 0;
  while (cut < parts.length - 1 && isUpper(parts[cut])) cut++;
  if (cut === 0) return raw.trim();
  const surname = parts.slice(0, cut).map((w, i) => {
    const low = w.toLocaleLowerCase();
    if (i < cut - 1 && PARTICLES.has(low)) return low;
    return low.replace(/(^|[-'])(\p{L})/gu, (_m, sep, ch) => sep + ch.toLocaleUpperCase());
  });
  return [...parts.slice(cut), ...surname].join(' ');
}

const localDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

const num = (v: string | number | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function events(ctx: AdapterContext): Promise<ApiEvent[]> {
  const data = await ctx.http.json<{ events: ApiEvent[] }>(`${BASE}?query=events&lang=en`);
  return (data.events ?? []).filter((e) => (e.raceSeries ?? []).includes(SERIES) && e.startTime && e.endTime);
}

const range = (season: number) => `raceSeries=${SERIES}&startDate=${season}-01-01&endDate=${season}-12-31&lang=en`;

// O "type" das sessoes nao e confiavel (ha "Pit Stop Challenge Race 1" e
// "Starting Groups" como race): corrida = nome "Race N".
const raceNumber = (s: ApiSession) => Number(s.name?.trim().match(/^race\s*(\d+)$/i)?.[1] ?? 0);

const toIso = (s?: string) => (s ? new Date(s).toISOString().replace('.000Z', 'Z') : null);

export const rules = {
  2026: {
    // Tabelas so como referencia: os totais vem dos pontos de cada linha.
    sessions: {
      race1: [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      race2: [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      qualifying1: [3, 2, 1],
      qualifying2: [3, 2, 1],
    },
    useSourcePoints: true,
  },
};

export const adapter: AdapterWithRules = {
  id: 'dtm',
  source: 'api.dtm.com',
  staleAfterHours: 24,
  rules,

  async listSeasons(ctx) {
    const years = (await events(ctx)).map((e) => Number(localDate(e.startTime).slice(0, 4)));
    return [...new Set(years)].sort((a, b) => a - b);
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const evs = (await events(ctx))
      .filter((e) => Number(localDate(e.startTime).slice(0, 4)) === season)
      .sort((a, b) => a.eventNumber - b.eventNumber || a.startTime.localeCompare(b.startTime));
    if (!evs.length) return { season, races: [], results: [], officialStandings: [], notes: ['Sem eventos DTM para a temporada.'] };

    // Nada de buscar resultados antes da primeira etapa comecar.
    const started = evs.some((e) => new Date(e.startTime) <= ctx.now);
    const [resData, stData] = started
      ? await Promise.all([
        ctx.http.json<{ wigeResultses?: { wigeEventId: number; startDate: string; jsonText: string }[] }>(
          `${BASE}?query=wigeResults&${range(season)}`,
        ),
        ctx.http.json<{ wigeStandingses?: { raceSeries: string; jsonText: string }[] }>(`${BASE}?query=wigeStandings&${range(season)}`),
      ])
      : [{ wigeResultses: [] }, { wigeStandingses: [] }];

    // Sessoes por evento: so corridas interessam (o quali vem nas linhas da corrida).
    const byEvent = new Map<number, { sessions: ApiSession[]; races: Map<number, ApiResultDoc> }>();
    for (const rec of resData.wigeResultses ?? []) {
      let doc: ApiResultDoc;
      try {
        doc = JSON.parse(rec.jsonText);
      } catch {
        notes.push(`Resultado ilegivel (evento ${rec.wigeEventId}).`);
        continue;
      }
      const ev = evs.find((e) => rec.wigeEventId === season * 100 + e.eventNumber) ??
        evs.find((e) => rec.startDate >= localDate(e.startTime) && rec.startDate <= localDate(e.endTime));
      if (!ev) continue;
      const entry = byEvent.get(ev.eventNumber) ?? { sessions: doc.sessions ?? [], races: new Map() };
      if ((doc.sessions ?? []).length > entry.sessions.length) entry.sessions = doc.sessions;
      const session = (doc.sessions ?? []).find((s) => s.sessionid === doc.sessionid);
      const n = session ? raceNumber(session) : 0;
      if (n && doc.result?.length) entry.races.set(n, doc);
      byEvent.set(ev.eventNumber, entry);
    }

    const races: RaceRecord[] = [];
    const results: RaceResult[] = [];
    const teamOf = new Map<string, string>();
    let partial = false;

    for (const ev of evs) {
      const round = ev.eventNumber;
      const short = shortEventName(ev.name);
      const raceId = `r${String(round).padStart(2, '0')}-${slug(short)}`;
      const info = byEvent.get(round);
      const plannedRaces = (info?.sessions ?? []).filter(raceNumber).length || 2;
      const done = info ? [...info.races.keys()].sort() : [];
      const complete = done.length >= plannedRaces;
      if (done.length && !complete) partial = true;
      const date = localDate(ev.endTime);
      const lastRace = (info?.sessions ?? []).filter(raceNumber).sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? '')).at(
        -1,
      );
      const fresh = ctx.now.getTime() - new Date(`${date}T23:59:59Z`).getTime() < PROVISIONAL_DAYS * 86400_000;
      const provisional = fresh && done.some((n) => info!.races.get(n)!.provision === 'provisional');

      const winners: string[] = [];
      for (const n of done) {
        const doc = info!.races.get(n)!;
        const rows: ResultRow[] = doc.result.map((r) => ({
          position: r.position ?? null,
          driver: driverName(r.name),
          team: r.team ?? null,
          number: r.number ?? null,
          status: r.status || (r.position ? 'Finished' : null),
          laps: r.laps ?? null,
          points: num(r.racepoints) + num(r.fastestlappoints),
        }));
        rows.forEach((r) => r.team && teamOf.set(r.driver, r.team));
        const win = rows.find((r) => r.position === 1);
        if (win) winners.push(win.driver);
        results.push({ raceId, session: `race${n}`, official: !provisional, rows });
        // Pontos do quali do dia (3-2-1) vem na linha da corrida.
        const quali = doc.result
          .filter((r) => num(r.qualifyingpoints) > 0)
          .sort((a, b) => num(b.qualifyingpoints) - num(a.qualifyingpoints))
          .map((r, i): ResultRow => ({
            position: i + 1,
            driver: driverName(r.name),
            team: r.team ?? null,
            number: r.number ?? null,
            points: num(r.qualifyingpoints),
          }));
        if (quali.length) results.push({ raceId, session: `qualifying${n}`, official: !provisional, rows: quali });
      }
      const uniqueWinners = [...new Set(winners)];

      races.push({
        raceId,
        round,
        name: short,
        enName: ev.name,
        location: ev.country?.name ? COUNTRY_PT[ev.country.name] ?? ev.country.name : null,
        enLocation: ev.country?.name ?? null,
        circuit: ev.racetrack?.name ?? null,
        date,
        startsAt: toIso(lastRace?.timeStart),
        status: complete ? 'completed' : 'upcoming',
        winner: complete && uniqueWinners.length ? uniqueWinners.join(' / ') : null,
        official: complete ? !provisional : undefined,
        externalId: ev.slug,
        sourceUrl: `https://www.dtm.com/en/events/${ev.slug}`,
      });
    }
    // Resultado de rodada pela metade nao entra no calculo (o motor so conta
    // rodada concluida), entao a oficial tambem fica de fora ate o domingo.
    if (partial) {
      notes.push('Rodada em andamento: classificacao oficial ignorada ate a ultima corrida do fim de semana.');
    }

    const officialStandings: StandingsSet[] = [];
    const asOfRound = Math.max(0, ...races.filter((r) => r.status === 'completed').map((r) => r.round)) || null;
    const st = (stData.wigeStandingses ?? []).find((s) => s.raceSeries === SERIES);
    if (st && !partial) {
      const doc = JSON.parse(st.jsonText) as Record<string, ApiStandingRow[]>;
      const toRows = (list: ApiStandingRow[] | undefined, names: (s: string) => string, withTeam: boolean): StandingRow[] =>
        (list ?? [])
          .filter((r) => r.name)
          .map((r) => ({
            position: r.position,
            name: names(r.name),
            team: withTeam ? teamOf.get(names(r.name)) ?? null : null,
            points: num(r.totalpoints),
          }))
          .sort((a, b) => a.position - b.position);
      const groups: [string, ApiStandingRow[] | undefined, (s: string) => string, boolean][] = [
        ['drivers', doc.drivers, driverName, true],
        ['teams', doc.teams, (s) => s, false],
        ['manufacturers', doc.manufacturers, (s) => s, false],
      ];
      for (const [group, list, names, withTeam] of groups) {
        const rows = toRows(list, names, withTeam);
        if (rows.length) officialStandings.push({ group, rows, asOfRound });
      }
    } else if (!st && results.length) {
      notes.push('Classificacao oficial (wigeStandings) ainda nao publicada.');
    }

    return { season, races, results, officialStandings, notes };
  },
};
