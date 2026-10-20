import type { AdapterContext, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// WRC pela API de resultados que alimenta o wrc.com (p-p.redbull.com,
// "rb-wrccom-lintegration"). O www.wrc.com bloqueia robo; esta API nao.
//
// - seasons.json: temporadas do "World Rally Championship" (seasonId por ano).
// - season-detail.json: rodadas (eventId, datas, pais) e campeonatos da
//   temporada; o de pilotos e o "FIA World Rally Championship for Drivers"
//   (sem WRC2/WRC3/Junior/Masters).
// - championship-overall-results.json: por piloto e rodada, posicao e
//   pointsBreakdown "geral + Super Sunday [+ Power Stage]" (a fonte omite o
//   ultimo termo quando o piloto nao pontuou na Power Stage).
// - events/{id}.json + rallies/{rallyId}/results.json + entries.json: so para
//   o vencedor geral (posicao 1 do resultado oficial do rali).
//
// Resultados: sessoes "race" (geral), "supersunday" e "powerstage", com os
// pontos da propria fonte (useSourcePoints).

const BASE = 'https://p-p.redbull.com/rb-wrccom-lintegration-yv-prod/api';
const SERIES_NAME = 'World Rally Championship';
const LIMIT = 4;

interface ApiSeason {
  seasonId: number;
  name: string;
  year: number;
}

interface ApiEvent {
  eventId: number;
  name: string;
  slug?: string;
  location?: string;
  startDate: string;
  finishDate: string;
  country?: { name?: string; iso3?: string };
  rallies?: { rallyId: number; isMain?: boolean }[];
}

interface ApiSeasonDetail {
  seasonRounds: { eventId: number; order: number; event: ApiEvent }[];
  championships: { championshipId: number; name: string; type: string }[];
}

interface ApiChampEntry {
  championshipEntryId: number;
  fieldOne: string;
  fieldTwo: string;
  fieldFour?: string;
  fieldFive?: string;
}

interface ApiRoundResult {
  eventId: number;
  position: string | null;
  totalPoints: number;
  pointsBreakdown: string | null;
  dropped?: boolean;
  status?: string;
  publishedStatus?: string;
}

interface ApiOverall {
  entryResults: { championshipEntryId: number; overallPosition: number; overallPoints: number; roundResults: ApiRoundResult[] }[];
}

interface ApiEntry {
  entryId: number;
  driver?: { firstName?: string; lastName?: string; fullName?: string };
  entrant?: { name?: string } | null;
}

// Nome curto em portugues: regiao quando o rali leva o nome dela, senao o pais.
const REGIONS: [RegExp, string][] = [
  [/monte[\s-]?carlo/i, 'Monte Carlo'],
  [/canari/i, 'Ilhas Canárias'],
  [/sardegna|sardinia/i, 'Sardenha'],
  [/safari/i, 'Quênia'],
  [/acropolis/i, 'Grécia'],
  [/central europe/i, 'Europa Central'],
  [/catalunya|catalonia/i, 'Catalunha'],
  [/corsica|corse/i, 'Córsega'],
  [/wales/i, 'País de Gales'],
  [/scotland/i, 'Escócia'],
];

const COUNTRY_PT: Record<string, string> = {
  MCO: 'Mônaco',
  SWE: 'Suécia',
  KEN: 'Quênia',
  HRV: 'Croácia',
  ESP: 'Espanha',
  PRT: 'Portugal',
  JPN: 'Japão',
  GRC: 'Grécia',
  EST: 'Estônia',
  FIN: 'Finlândia',
  PRY: 'Paraguai',
  CHL: 'Chile',
  ITA: 'Itália',
  SAU: 'Arábia Saudita',
  POL: 'Polônia',
  LVA: 'Letônia',
  DEU: 'Alemanha',
  BEL: 'Bélgica',
  GBR: 'Reino Unido',
  MEX: 'México',
  ARG: 'Argentina',
  NZL: 'Nova Zelândia',
  AUS: 'Austrália',
  TUR: 'Turquia',
  FRA: 'França',
  CZE: 'República Tcheca',
  AUT: 'Áustria',
  IRL: 'Irlanda',
  USA: 'Estados Unidos',
  NOR: 'Noruega',
};

export function roundName(ev: ApiEvent): string {
  const hit = REGIONS.find(([re]) => re.test(ev.name));
  if (hit) return hit[1];
  return COUNTRY_PT[ev.country?.iso3 ?? ''] ?? ev.country?.name ?? ev.name;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "Elfyn" + "EVANS" -> "Elfyn Evans"; "MCERLEAN" -> "McErlean". */
export function personName(first: string, last: string): string {
  const fix = (w: string) =>
    w === w.toLocaleUpperCase() && w !== w.toLocaleLowerCase()
      ? w.toLocaleLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep, ch) => sep + ch.toLocaleUpperCase()).replace(
        /\bMc(\p{L})/gu,
        (_m, ch) => 'Mc' + ch.toLocaleUpperCase(),
      )
      : w;
  return [first.trim(), fix(last.trim())].filter(Boolean).join(' ');
}

/** "25 + 5 + 4" -> [25, 5, 4]; "-" / "R" -> []. */
export function breakdown(s: string | null | undefined): number[] {
  if (!s || !/\d/.test(s)) return [];
  return s.split('+').map((p) => Number(p.trim()) || 0);
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

async function wrcSeasons(ctx: AdapterContext): Promise<ApiSeason[]> {
  const list = await ctx.http.json<ApiSeason[]>(`${BASE}/seasons.json`);
  return list.filter((s) => s.name?.trim() === SERIES_NAME);
}

/** Vencedor geral: posicao 1 do resultado do rali principal. */
async function overallWinner(ctx: AdapterContext, eventId: number): Promise<string | null> {
  const ev = await ctx.http.json<ApiEvent>(`${BASE}/events/${eventId}.json`);
  const rally = ev.rallies?.find((r) => r.isMain) ?? ev.rallies?.[0];
  if (!rally) return null;
  const base = `${BASE}/events/${eventId}/rallies/${rally.rallyId}`;
  const results = await ctx.http.json<{ entryId: number; position: number | null }[]>(`${base}/results.json`);
  const first = results.find((r) => r.position === 1);
  if (!first) return null;
  const entries = await ctx.http.json<ApiEntry[]>(`${base}/entries.json`);
  const d = entries.find((e) => e.entryId === first.entryId)?.driver;
  return d ? personName(d.firstName ?? '', d.lastName ?? d.fullName ?? '') : null;
}

export const rules = {
  2026: {
    // Referencia; os totais vem do pointsBreakdown de cada piloto.
    sessions: {
      race: [25, 17, 15, 12, 10, 8, 6, 4, 2, 1],
      supersunday: [5, 4, 3, 2, 1],
      powerstage: [5, 4, 3, 2, 1],
    },
    useSourcePoints: true,
  },
};

const SESSIONS = ['race', 'supersunday', 'powerstage'];

export const adapter: AdapterWithRules = {
  id: 'wrc',
  source: 'wrc.com (api p-p.redbull.com)',
  // Resultado oficial sai depois da Power Stage de domingo; folga para a FIA.
  staleAfterHours: 36,
  rules,

  async listSeasons(ctx) {
    return [...new Set((await wrcSeasons(ctx)).map((s) => s.year))].sort((a, b) => a - b);
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const meta = (await wrcSeasons(ctx)).find((s) => s.year === season);
    if (!meta) throw new Error(`Temporada ${season} nao encontrada em seasons.json.`);
    const detail = await ctx.http.json<ApiSeasonDetail>(`${BASE}/season-detail.json?seasonId=${meta.seasonId}`);
    const rounds = [...(detail.seasonRounds ?? [])].sort((a, b) => a.order - b.order);
    const champ = detail.championships.find((c) =>
      c.type === 'Drivers' && /World Rally Championship for Drivers/i.test(c.name) && !/WRC\s*\d|Junior|Masters|Challenger/i.test(c.name)
    );
    if (!champ) throw new Error('Campeonato de pilotos do WRC nao encontrado em season-detail.json.');

    const today = ctx.now.toISOString().slice(0, 10);
    const started = rounds.some((r) => r.event.startDate <= today);
    const q = `championshipId=${champ.championshipId}&seasonId=${meta.seasonId}`;
    const [champDetail, overall] = started
      ? await Promise.all([
        ctx.http.json<{ championshipEntries: ApiChampEntry[] }>(`${BASE}/championship-detail.json?${q}`),
        ctx.http.json<ApiOverall>(`${BASE}/championship-overall-results.json?${q}`),
      ])
      : [{ championshipEntries: [] }, { entryResults: [] }];
    const entries = new Map(champDetail.championshipEntries.map((e) => [e.championshipEntryId, e]));
    const nameOf = (id: number) => {
      const e = entries.get(id);
      return e ? personName(e.fieldOne, e.fieldTwo) : null;
    };

    // Linhas por rodada (eventId).
    const perEvent = new Map<number, { name: string; team: string | null; r: ApiRoundResult }[]>();
    for (const er of overall.entryResults ?? []) {
      const name = nameOf(er.championshipEntryId);
      if (!name) continue;
      const team = entries.get(er.championshipEntryId)?.fieldFive ?? null;
      for (const r of er.roundResults ?? []) {
        if (!perEvent.has(r.eventId)) perEvent.set(r.eventId, []);
        perEvent.get(r.eventId)!.push({ name, team, r });
      }
    }

    const scored = (eventId: number) => (perEvent.get(eventId) ?? []).some((x) => breakdown(x.r.pointsBreakdown).length > 0);
    const done = rounds.filter((r) => scored(r.eventId));
    // Vencedor geral (3 pedidos por rali, so dos concluidos; cache em params).
    const saved = (ctx.params.wrcWinners ?? {}) as Record<string, string>;
    const cache = Object.fromEntries(Object.entries(saved).filter(([k]) => k.startsWith(`${season}:`)));
    const winners = new Map<number, string | null>();
    await mapLimit(done, LIMIT, async (r) => {
      const key = `${season}:${r.eventId}`;
      if (cache[key]) return winners.set(r.eventId, cache[key]);
      try {
        const w = await overallWinner(ctx, r.eventId);
        winners.set(r.eventId, w);
        if (w) cache[key] = w;
      } catch (error) {
        notes.push(
          `Resultado geral de ${r.event.name} indisponivel (${
            error instanceof Error ? error.message : error
          }); vencedor pela classificacao do campeonato.`,
        );
        winners.set(r.eventId, null);
      }
    });
    if (done.length) ctx.params.wrcWinners = cache;

    const races: RaceRecord[] = [];
    const results: RaceResult[] = [];
    for (const { order, event: ev } of rounds) {
      const name = roundName(ev);
      const raceId = `r${String(order).padStart(2, '0')}-${slug(name)}`;
      const rows = perEvent.get(ev.eventId) ?? [];
      const complete = scored(ev.eventId);
      const official = complete && rows.every((x) => !x.r.publishedStatus || x.r.publishedStatus === 'Published');
      let winner = winners.get(ev.eventId) ?? null;
      if (complete && !winner) winner = rows.find((x) => x.r.position === '1')?.name ?? null;

      if (complete) {
        const bySession: ResultRow[][] = [[], [], []];
        for (const { name: driver, team, r } of rows) {
          const parts = breakdown(r.pointsBreakdown);
          const pos = Number(r.position);
          const keep = r.dropped ? 0 : 1;
          if (parts.length || (Number.isFinite(pos) && pos > 0)) {
            bySession[0].push({
              position: Number.isFinite(pos) && pos > 0 ? pos : null,
              driver,
              team,
              status: r.status ?? null,
              points: (parts[0] ?? 0) * keep,
            });
          }
          for (const i of [1, 2]) if ((parts[i] ?? 0) > 0) bySession[i].push({ position: null, driver, team, points: parts[i] * keep });
        }
        bySession[0].sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
        // Super Sunday / Power Stage: posicao pela pontuacao (5 = 1o).
        for (const i of [1, 2]) bySession[i].sort((a, b) => b.points! - a.points!).forEach((row, k) => (row.position = k + 1));
        SESSIONS.forEach((session, i) => bySession[i].length && results.push({ raceId, session, official, rows: bySession[i] }));
      }

      races.push({
        raceId,
        round: order,
        name,
        enName: ev.name,
        location: ev.location?.split(',')[0].trim() || null,
        enLocation: ev.location ?? null,
        circuit: null,
        date: ev.finishDate.slice(0, 10),
        startsAt: null,
        status: complete ? 'completed' : 'upcoming',
        winner: complete ? winner : null,
        official: complete ? official : undefined,
        externalId: String(ev.eventId),
        sourceUrl: ev.slug ? `https://www.wrc.com/en/championship/calendar/wrc/${ev.slug}` : null,
      });
    }

    const asOfRound = done.length ? Math.max(...done.map((r) => r.order)) : null;
    const rows: StandingRow[] = (overall.entryResults ?? [])
      .filter((e) => e.overallPosition > 0 && nameOf(e.championshipEntryId))
      .map((e) => ({
        position: e.overallPosition,
        name: nameOf(e.championshipEntryId)!,
        team: entries.get(e.championshipEntryId)?.fieldFive ?? null,
        points: e.overallPoints,
      }))
      .sort((a, b) => a.position - b.position || b.points - a.points);
    const missing = rounds.filter((r) => r.event.finishDate.slice(0, 10) < today && !scored(r.eventId));
    if (missing.length) notes.push(`Sem pontos publicados ainda: ${missing.map((r) => r.event.name).join(', ')}.`);

    return { season, races, results, officialStandings: rows.length ? [{ group: 'drivers', rows, asOfRound }] : [], notes };
  },
};
