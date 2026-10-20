import type { AdapterContext, RaceRecord, RaceResult, Snapshot, StandingRow } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// NASCAR Cup Series (series_1) pelos feeds publicos "cacher" da NASCAR.
//
// Sem "rules": a classificacao da Cup tem playoffs/Chase (zera e reposiciona
// os classificados), entao somar os pontos das corridas nao chega ao numero
// oficial. O motor publica a classificacao do feed oficial
// (racinginsights-points-feed) e os resultados ficam so como historico.

const BASE = 'https://cf.nascar.com/cacher';
const SERIES = 1;
const POINTS_RACE = 1; // race_type_id 2 = exibicao (Clash, Duels, All-Star)

interface ApiRace {
  race_id: number;
  race_name: string;
  race_type_id: number;
  track_name: string;
  race_date: string;
  date_scheduled: string;
  winner_driver_id: number | null;
  inspection_complete?: boolean;
  schedule?: { event_name: string; start_time_utc: string; run_type: number }[];
}

interface ApiPoints {
  position: number;
  driver_id: number;
  driver_name: string;
  points: number;
}

interface ApiResult {
  finishing_position: number;
  driver_fullname: string;
  driver_id: number;
  car_number: string;
  team_name: string;
  laps_completed: number;
  finishing_status: string;
  points_earned: number;
}

interface WeekendFeed {
  weekend_race: { race_id: number; inspection_complete?: boolean; results: ApiResult[] }[];
}

// Nome curto (cidade/autodromo) para o app. Fallback: tira o sufixo do autodromo.
const SHORT_NAMES: Record<string, string> = {
  'Circuit of The Americas': 'Austin',
  'World Wide Technology Raceway': 'Gateway',
  'Homestead-Miami Speedway': 'Homestead',
  'Charlotte Motor Speedway Road Course': 'Charlotte Roval',
  'Autodromo Hermanos Rodriguez': 'Cidade do Mexico',
};

export function shortTrackName(track: string): string {
  const plain = track.normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (SHORT_NAMES[plain]) return SHORT_NAMES[plain];
  return plain.replace(/\s+(International\s+)?(Motor\s+)?(Superspeedway|Speedway|Raceway|Stadium|Street Course|International)$/i, '')
    .trim() || plain;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

async function raceList(ctx: AdapterContext, year: number): Promise<ApiRace[]> {
  const data = await ctx.http.json<Record<string, ApiRace[]>>(`${BASE}/${year}/race_list_basic.json`);
  return data[`series_${SERIES}`] ?? [];
}

export const adapter: AdapterWithRules = {
  id: 'nascar',
  source: 'cf.nascar.com (feeds oficiais NASCAR)',
  staleAfterHours: 12,

  // A fonte nao tem lista de temporadas: testa o ano atual e o seguinte.
  async listSeasons(ctx) {
    const year = ctx.now.getUTCFullYear();
    const found: number[] = [];
    for (const y of [year, year + 1]) {
      try {
        const races = await raceList(ctx, y);
        if (races.some((r) => r.race_type_id === POINTS_RACE)) found.push(y);
      } catch {
        // 403/404 = temporada ainda nao publicada
      }
    }
    return found;
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const list = (await raceList(ctx, season))
      .filter((r) => r.race_type_id === POINTS_RACE)
      .sort((a, b) => a.race_date.localeCompare(b.race_date));

    let points: ApiPoints[] = [];
    try {
      points = await ctx.http.json<ApiPoints[]>(`${BASE}/${season}/${SERIES}/racinginsights-points-feed.json`);
    } catch (error) {
      notes.push(`Classificacao oficial indisponivel: ${error instanceof Error ? error.message : error}`);
    }
    // Nome como na classificacao oficial (o resultado as vezes grafa diferente: "Suárez", "Van Gisbergen").
    const names = new Map<number, string>(points.map((p) => [p.driver_id, p.driver_name]));
    const driverName = (x: ApiResult) => names.get(x.driver_id) ?? x.driver_fullname.trim();

    // Resultado so de corrida que ja tem vencedor (as demais nao tem o que buscar).
    const done = list.filter((r) => r.winner_driver_id != null);
    const feeds = await mapLimit(done, 4, async (r) => {
      try {
        return await ctx.http.json<WeekendFeed>(`${BASE}/${season}/${SERIES}/${r.race_id}/weekend-feed.json`);
      } catch {
        return null;
      }
    });
    const missing = done.filter((_, i) => !feeds[i]);
    if (missing.length) {
      notes.push(`Sem resultado detalhado (weekend-feed) para: ${missing.map((r) => shortTrackName(r.track_name)).join(', ')}.`);
    }

    const feedById = new Map<number, ApiResult[]>();
    feeds.forEach((f, i) => {
      const rows = f?.weekend_race?.[0]?.results?.filter((x) => x.finishing_position > 0) ?? [];
      if (rows.length) feedById.set(done[i].race_id, rows);
    });
    const teams = new Map<string, string>();
    for (const rows of feedById.values()) for (const x of rows) if (x.team_name) teams.set(driverName(x), x.team_name);

    const races: RaceRecord[] = [];
    const results: RaceResult[] = [];
    list.forEach((r, i) => {
      const round = i + 1;
      const name = shortTrackName(r.track_name);
      const raceId = `r${String(round).padStart(2, '0')}-${slug(name)}`;
      const start = r.schedule?.find((s) => s.run_type === 3)?.start_time_utc;
      const rows = feedById.get(r.race_id) ?? [];
      const winnerRow = rows.find((x) => x.driver_id === r.winner_driver_id) ?? rows.find((x) => x.finishing_position === 1);
      const winnerName = r.winner_driver_id != null ? names.get(r.winner_driver_id) ?? (winnerRow ? driverName(winnerRow) : null) : null;
      const completed = r.winner_driver_id != null;
      const official = r.inspection_complete !== false;
      races.push({
        raceId,
        round,
        name,
        enName: r.race_name.trim(),
        circuit: r.track_name.trim(),
        date: r.race_date.slice(0, 10),
        startsAt: start ? `${start.replace(/Z$/, '')}Z` : null,
        status: completed ? 'completed' : 'upcoming',
        winner: completed ? winnerName : null,
        official: completed ? official : true,
        externalId: String(r.race_id),
        sourceUrl: `https://www.nascar.com/results/racecenter/${season}/nascar-cup-series/${r.race_id}/`,
      });
      if (completed && rows.length) {
        results.push({
          raceId,
          session: 'race',
          official,
          rows: [...rows].sort((a, b) => a.finishing_position - b.finishing_position).map((x) => ({
            position: x.finishing_position,
            driver: driverName(x),
            team: x.team_name || null,
            number: x.car_number,
            status: x.finishing_status || null,
            laps: x.laps_completed,
            points: x.points_earned,
          })),
        });
      }
    });

    const completedRounds = races.filter((r) => r.status === 'completed').map((r) => r.round);
    const rows: StandingRow[] = [...points]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ position: p.position, name: p.driver_name, team: teams.get(p.driver_name) ?? null, points: p.points }));
    if (races.some((r) => r.status === 'completed' && r.official === false)) notes.push('Ha resultado aguardando vistoria (provisorio).');

    return {
      season,
      races,
      results,
      officialStandings: rows.length
        ? [{ group: 'drivers', rows, asOfRound: completedRounds.length ? Math.max(...completedRounds) : null }]
        : [],
      notes,
    };
  },
};
