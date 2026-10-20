import type { AdapterContext, RaceRecord, RaceResult, Snapshot, StandingRow } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// NTT IndyCar Series pela API publica de resultados do indycar.com.
//
// - YearPointSummary: lista das corridas que pontuam (na ordem do campeonato)
//   e a classificacao oficial. Ja vem preenchida para a temporada seguinte
//   assim que o calendario sai, entao serve tambem para descobrir temporadas.
// - EventsSessionDetails: data, nome e resultado de cada corrida (PointsEarned
//   ja inclui bonus: pole, voltas lideradas e classificacao da Indy 500).
// - /schedule (HTML): local, autodromo e horario da largada.

const API = 'https://www.indycar.com/api/results';
const SERIES = 'b856a4f1-e85c-4fac-8c36-fd58d962227a'; // NTT INDYCAR SERIES
const SCHEDULE = 'https://www.indycar.com/schedule';

interface PointSummary {
  Year: number;
  RaceAbbreviations: { Track: string; EventsSessionsID: number }[];
  DriverList: { DriverName: string; OverallPosition: number; TotalPoints: number }[];
}

interface SessionDetails {
  EventName: string;
  SessionName: string;
  SessionDate: string; // M/D/YYYY
  records: {
    PositionFinish: number | null;
    DriverName: string;
    TeamName: string | null;
    CarNumber: string | null;
    Status: string | null;
    LapsComplete: number | null;
    PointsEarned: number | null;
  }[];
}

interface Card {
  year: number;
  slug: string;
  date: string;
  time: string | null;
  title: string;
  track: string | null;
  location: string | null;
}

// Nome curto pela sigla que a propria IndyCar usa na tabela de pontos.
const ABBR_NAMES: Record<string, string> = {
  STP: 'St. Petersburg',
  PHX: 'Phoenix',
  ARL: 'Arlington',
  BAR: 'Barber',
  LB: 'Long Beach',
  GPI: 'Indianapolis (misto)',
  IND: 'Indy 500',
  DET: 'Detroit',
  STL: 'Gateway',
  'R-AM': 'Road America',
  MOH: 'Mid-Ohio',
  NAS: 'Nashville',
  POR: 'Portland',
  MRKM: 'Markham',
  WASH: 'Washington',
  MIL: 'Milwaukee',
  WRLS: 'Laguna Seca',
  TOR: 'Toronto',
  IOWA: 'Iowa',
  TXS: 'Texas',
  THE: 'Thermal',
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = (s: string) => slug(s).replace(/-/g, '');
const pad = (n: number) => String(n).padStart(2, '0');
const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Horario do leste dos EUA (ET) -> ISO UTC. Horario de verao: 2o domingo de marco a 1o domingo de novembro. */
export function easternToUtc(date: string, time: string): string | null {
  const m = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const [y, mo, d] = date.split('-').map(Number);
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const day = Date.UTC(y, mo - 1, d);
  const dst = day >= Date.UTC(y, 2, nthSunday(3, 2)) && day < Date.UTC(y, 10, nthSunday(11, 1));
  return new Date(Date.UTC(y, mo - 1, d, h + (dst ? 4 : 5), Number(m[2]))).toISOString().replace('.000Z', 'Z');
}

/** Cartoes de evento da pagina /schedule (aparecem repetidos nas abas; deduplica pelo link). */
export function parseSchedule(html: string): Card[] {
  const cards = new Map<string, Card>();
  const get = (c: string, cls: string) => {
    const m = c.match(new RegExp(`class="${cls}">([^<]*)<`));
    return m ? decode(m[1]) || null : null;
  };
  for (const chunk of html.split(/<div class="event-card event-card-small/).slice(1)) {
    const href = chunk.match(/href="\/Schedule\/(\d{4})\/([^"]+)"/i);
    const day = get(chunk, 'event-card-header-date')?.match(/^([A-Za-z]{3})\w*\s+(\d{1,2})/);
    const title = get(chunk, 'event-card-title');
    if (!href || !day || !title) continue;
    const month = MONTHS[day[1].toLowerCase()];
    if (!month) continue;
    const year = Number(href[1]);
    const key = `${year}/${href[2]}`;
    if (cards.has(key)) continue;
    cards.set(key, {
      year,
      slug: href[2],
      date: `${year}-${pad(month)}-${pad(Number(day[2]))}`,
      time: get(chunk, 'event-card-header-time'),
      title,
      track: get(chunk, 'event-card-track-name'),
      location: get(chunk, 'event-card-track-location'),
    });
  }
  return [...cards.values()];
}

const summaryUrl = (year: number) => `${API}/YearPointSummary?year=${year}&id=${SERIES}`;

function raceSessions(summary: PointSummary | null) {
  return (summary?.RaceAbbreviations ?? []).filter((r) => r.EventsSessionsID > 0 && r.Track !== 'Total');
}

function usDate(s: string): string | null {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}` : null;
}

async function trySummary(ctx: AdapterContext, year: number): Promise<PointSummary | null> {
  try {
    return await ctx.http.json<PointSummary>(summaryUrl(year));
  } catch {
    return null;
  }
}

export const adapter: AdapterWithRules = {
  id: 'indy',
  source: 'indycar.com (API de resultados)',

  async listSeasons(ctx) {
    const year = ctx.now.getUTCFullYear();
    let years: number[] = [];
    try {
      years = (await ctx.http.json<number[]>(`${API}/YearsBySeries?series=${SERIES}`)).map(Number).filter((y) => y >= year - 1);
    } catch {
      // segue so com a sondagem abaixo
    }
    // A lista de anos so ganha o ano novo depois da 1a corrida; o resumo de
    // pontos ja traz o calendario antes disso.
    for (const y of [year, year + 1]) {
      if (years.includes(y)) continue;
      if (raceSessions(await trySummary(ctx, y)).length) years.push(y);
    }
    return years.sort((a, b) => a - b);
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const summary = await ctx.http.json<PointSummary>(summaryUrl(season));
    const sessions = raceSessions(summary);
    if (!sessions.length) throw new Error(`IndyCar ${season}: resumo de pontos sem corridas.`);

    let cards: Card[] = [];
    try {
      cards = parseSchedule(await ctx.http.text(SCHEDULE)).filter((c) => c.year === season);
    } catch (error) {
      notes.push(`Pagina de calendario indisponivel (sem local/horario): ${error instanceof Error ? error.message : error}`);
    }

    // Nome oficial de cada corrida (so existe depois que a temporada entra na lista de anos).
    const eventBySession = new Map<number, string>();
    try {
      const seasons = await ctx.http.json<
        { Year: string; Events: { EventName: string; Sessions: { EventsSessionID: string }[] | null }[] }[]
      >(
        `${API}/SeasonDropDown?id=${SERIES}`,
      );
      for (const ev of seasons.find((y) => Number(y.Year) === season)?.Events ?? []) {
        for (const s of ev.Sessions ?? []) eventBySession.set(Number(s.EventsSessionID), decode(ev.EventName));
      }
    } catch {
      // sem nomes: o detalhe de cada corrida supre
    }

    // Cartao do calendario: mesmo nome de evento (ou de autodromo), de preferencia na mesma data.
    const used = new Set<Card>();
    const findCard = (event: string | null, date: string | null) => {
      if (!event) return undefined;
      const pool = cards.filter((c) => !used.has(c));
      const sameName = (c: Card) => norm(c.title) === norm(event) || (!!c.track && norm(c.track) === norm(event));
      const card = pool.find((c) => sameName(c) && (!date || c.date === date)) ?? pool.find(sameName);
      if (card) used.add(card);
      return card;
    };
    const today = ctx.now.toISOString().slice(0, 10);
    const pre = sessions.map((s) => findCard(eventBySession.get(s.EventsSessionsID) ?? null, null));

    // Detalhe (data, nome e resultado). E lento (~2 s cada): pula corrida com data futura no calendario.
    const details = await mapLimit(sessions, 4, async (s, i) => {
      if (pre[i] && pre[i]!.date > today) return null;
      try {
        return await ctx.http.json<SessionDetails>(`${API}/EventsSessionDetails?id=${s.EventsSessionsID}`);
      } catch {
        return undefined;
      }
    });

    const items = sessions.map((s, index) => {
      const det = details[index];
      const date = det ? usDate(det.SessionDate) : null;
      const event = eventBySession.get(s.EventsSessionsID) ?? (det?.EventName ? decode(det.EventName) : null);
      const card = pre[index] ?? findCard(event, date);
      const rows = (det?.records ?? []).filter((r) => r.DriverName);
      const winner = rows.find((r) => r.PositionFinish === 1 && (r.LapsComplete ?? 0) > 0);
      return { s, index, det, date: date ?? card?.date ?? null, event, card, rows, winner };
    });

    const missing = items.filter((i) => !i.date);
    if (missing.length) notes.push(`Corrida(s) sem data na fonte, fora do calendario: ${missing.map((i) => i.s.Track).join(', ')}.`);
    const dated = items.filter((i) => i.date).map((i) => ({
      ...i,
      startsAt: i.card?.time && i.date ? easternToUtc(i.date, i.card.time) : null,
    }));
    dated.sort((a, b) => a.date!.localeCompare(b.date!) || (a.startsAt ?? '').localeCompare(b.startsAt ?? '') || a.index - b.index);

    // Mesmo nome duas vezes (rodada dupla): "Milwaukee 1", "Milwaukee 2".
    const baseName = (i: (typeof dated)[number]) =>
      ABBR_NAMES[i.s.Track] ?? (i.card ? i.card.slug.replace(/-Race\d+$/i, '').replace(/-/g, ' ') : null) ?? i.event ?? i.s.Track;
    const counts = new Map<string, number>();
    for (const i of dated) counts.set(baseName(i), (counts.get(baseName(i)) ?? 0) + 1);
    const seen = new Map<string, number>();

    const races: RaceRecord[] = [];
    const results: RaceResult[] = [];
    const teams = new Map<string, string>();
    dated.forEach((i, idx) => {
      const round = idx + 1;
      let name = baseName(i);
      if ((counts.get(name) ?? 0) > 1) {
        seen.set(name, (seen.get(name) ?? 0) + 1);
        name = `${name} ${seen.get(name)}`;
      }
      const raceId = `r${pad(round)}-${slug(name)}`;
      const completed = !!i.winner;
      races.push({
        raceId,
        round,
        name,
        enName: i.card?.title ?? i.event,
        location: i.card?.location ?? null,
        circuit: i.card?.track ?? null,
        date: i.date!,
        startsAt: i.startsAt,
        status: completed ? 'completed' : 'upcoming',
        winner: i.winner?.DriverName.trim() ?? null,
        official: true,
        externalId: String(i.s.EventsSessionsID),
        sourceUrl: i.card ? `https://www.indycar.com/Schedule/${season}/${i.card.slug}` : null,
      });
      if (completed) {
        for (const r of i.rows) if (r.TeamName) teams.set(r.DriverName.trim(), r.TeamName.trim());
        results.push({
          raceId,
          session: 'race',
          official: true,
          rows: [...i.rows]
            .sort((a, b) => (a.PositionFinish ?? 999) - (b.PositionFinish ?? 999))
            .map((r) => ({
              position: r.PositionFinish || null,
              driver: r.DriverName.trim(),
              team: r.TeamName?.trim() || null,
              number: r.CarNumber ?? null,
              status: r.Status ?? null,
              laps: r.LapsComplete ?? null,
              points: r.PointsEarned ?? 0,
            })),
        });
      }
    });

    const failed = details.filter((d) => d === undefined).length;
    if (failed) notes.push(`${failed} corrida(s) sem detalhe na API nesta leitura.`);

    const done = races.filter((r) => r.status === 'completed');
    const rows: StandingRow[] = (summary.DriverList ?? [])
      .filter((d) => d.DriverName)
      .sort((a, b) => a.OverallPosition - b.OverallPosition)
      .map((d) => ({
        position: d.OverallPosition,
        name: d.DriverName.trim(),
        team: teams.get(d.DriverName.trim()) ?? null,
        points: d.TotalPoints,
      }));

    return {
      season,
      races,
      results,
      officialStandings: rows.length && done.length ? [{ group: 'drivers', rows, asOfRound: Math.max(...done.map((r) => r.round)) }] : [],
      notes,
    };
  },

  // PointsEarned da API ja soma pole, voltas lideradas e a classificacao da Indy 500.
  rules: {
    2026: { sessions: { race: [] }, useSourcePoints: true },
  },
};
