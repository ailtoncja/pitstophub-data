import type { AdapterWithRules } from '../engine.ts';
import type { AdapterContext, PointsRules, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow, StandingsSet } from '../types.ts';

// WEC e IMSA pelo arquivo de cronometragem da Al Kamel Systems.
//
// - Indice (/): <select name="season"> com as temporadas ("15_2026") e
//   <select name="evvent"> com os eventos da temporada. A pagina de cada evento
//   (?season=..&evvent=..) lista todos os arquivos (Results/...). Os nomes de
//   pasta tem data/hora e variam (_Final, _Official, _Provisional...), entao
//   tudo sai dos links da pagina; nada de caminho montado a mao.
// - So a pasta da serie principal conta ("NNN_FIA WEC",
//   "NN_IMSA WeatherTech SportsCar Championship"); suporte, rookie test etc. ficam de fora.
// - Classificacao por piloto: cada carro vira uma linha por piloto, todas com a
//   mesma posicao geral. computeStandings (perClass) calcula a posicao na classe
//   e faz os pilotos do mesmo carro dividirem essa posicao. A classe principal
//   (Hypercar / GTP) vira o grupo "drivers" via classGroupNames; as outras ficam
//   em "class:<CLASSE>".
// - WEC: calendario completo (inclusive etapas futuras) e classificacao oficial
//   de Hypercar e LMGT3 vem de fiawec.com/en/season/<ano> (HTML do servidor).
// - IMSA: imsa.com fica atras de desafio anti-robo, entao o calendario so tem os
//   eventos que ja apareceram na Al Kamel e a classificacao oficial (so em PDF)
//   nao e lida: publica-se a calculada.

const pad = (n: number) => String(n).padStart(2, '0');
const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normKey = (s: string) => slugify(s).replace(/-/g, '');
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function decodeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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

/** "Sébastien BUEMI" / "BRENDON HARTLEY" -> "Sébastien Buemi" / "Brendon Hartley". */
export function titleName(raw: string): string {
  const cap = (w: string) => w.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
  return raw.trim().split(/\s+/).map((w) => (/\p{L}{2}/u.test(w) && w === w.toUpperCase() ? cap(w) : w)).join(' ');
}

/** YYYYMMDDhhmm (horario local do autodromo) -> YYYY-MM-DD. */
const tsDate = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
/** Instante aproximado (trata o horario local como UTC; so serve para "ja passou?"). */
const tsTime = (ts: string) => Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(';').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(';');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

// ---------------------------------------------------------------------------
// Indice e paginas de evento da Al Kamel

export interface Option {
  value: string;
  label: string;
  selected: boolean;
}

export function parseSelect(html: string, name: string): Option[] {
  const block = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!block) return [];
  return [...block[1].matchAll(/<option\s+value="([^"]*)"([^>]*)>([^<]*)/gi)].map((m) => ({
    value: decodeHtml(m[1]),
    label: decodeHtml(m[3]),
    selected: /selected/i.test(m[2]),
  }));
}

/** "2026" -> 2026; "2018-2019" -> 2018 (temporada que cruza o ano usa o ano de inicio). */
export function seasonYear(label: string): number | null {
  const m = label.match(/^(\d{4})(?:-\d{4})?$/);
  return m ? Number(m[1]) : null;
}

export interface FileRef {
  /** Caminho como aparece no link (ja codificado), relativo a base. */
  href: string;
  session: string;
  /** YYYYMMDDhhmm da sessao. */
  ts: string;
  rank: number;
  official: boolean;
}

export interface EventInfo {
  /** Valor do select de temporada ("15_2026"). */
  season: string;
  value: string;
  label: string;
  /** Tem pasta da serie principal. */
  main: boolean;
  sessions: string[];
  race: FileRef | null;
  /** Grid oficial da corrida (IMSA: tempo de classificacao ja com punicoes). */
  grid?: FileRef | null;
  /** Melhor arquivo de cada sessao de classificacao (qualifying/hyperpole). */
  quali: FileRef[];
  /** Pontos do campeonato publicados na pasta do evento. */
  points: boolean;
  lastTs: string | null;
}

interface Series {
  base: string;
  main: RegExp;
  raceSession: RegExp;
  raceFile: RegExp;
  qualiSession: RegExp;
  qualiFile: RegExp;
  gridFile?: RegExp;
  rank(file: string): number;
  isOfficial(file: string): boolean;
  /** Evento ja nao muda: entra no cache de params. */
  settled(ev: EventInfo): boolean;
}

export function parseEvent(html: string, series: Series, season: string, value: string, label: string): EventInfo {
  const ev: EventInfo = { season, value, label, main: false, sessions: [], race: null, quali: [], points: false, lastTs: null };
  const sessions = new Set<string>();
  const quali = new Map<string, FileRef>();
  let lastAny: string | null = null;
  let lastMain: string | null = null;
  const hrefs = new Set([...html.matchAll(/href="(Results\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')));
  for (const href of hrefs) {
    const parts = safeDecodeUri(href).split('/');
    if (parts.length < 5) continue;
    for (const seg of parts.slice(4)) {
      const t = seg.match(/^(\d{12})_/)?.[1];
      if (t && (!lastAny || t > lastAny)) lastAny = t;
    }
    if (!series.main.test(parts[3])) continue;
    ev.main = true;
    const rest = parts.slice(4);
    const file = rest[rest.length - 1];
    const sm = rest[0].match(/^(\d{12})_(.+)$/);
    if (!sm) {
      if (/points|champion/i.test(rest[0])) ev.points = true;
      continue;
    }
    const [, ts, session] = sm;
    sessions.add(session);
    if (!lastMain || ts > lastMain) lastMain = ts;
    const ref = (): FileRef => ({ href, session, ts, rank: series.rank(rest.slice(1).join('/')), official: series.isOfficial(file) });
    if (series.raceSession.test(session) && series.raceFile.test(file)) {
      const r = ref();
      if (!ev.race || r.rank > ev.race.rank || (r.rank === ev.race.rank && r.ts > ev.race.ts)) ev.race = r;
    } else if (series.raceSession.test(session) && series.gridFile?.test(file)) {
      const r = ref();
      if (!ev.grid || r.rank > ev.grid.rank) ev.grid = r;
    } else if (series.qualiSession.test(session) && series.qualiFile.test(file)) {
      const r = ref();
      const prev = quali.get(session);
      if (!prev || r.rank > prev.rank) quali.set(session, r);
    }
  }
  ev.sessions = [...sessions];
  ev.quali = [...quali.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  ev.lastTs = lastMain ?? lastAny;
  return ev;
}

const seasonUrl = (s: Series, season: string) => `${s.base}?season=${encodeURIComponent(season)}`;
const eventUrl = (s: Series, season: string, ev: string) => `${seasonUrl(s, season)}&evvent=${encodeURIComponent(ev)}`;

const indexMemo = new WeakMap<AdapterContext, { base: string; html: string }>();

/**
 * Pagina do indice. O WEC fica atras do CloudFront, que guarda a versao
 * comprimida ignorando a query (?season/&evvent) e devolveria sempre o mesmo
 * evento; sem compressao a resposta vem do servidor. Mesmo assim, confere se
 * veio o evento pedido.
 */
async function getPage(series: Series, ctx: AdapterContext, season?: string, event?: string): Promise<string> {
  if (!season) {
    // Indice: listSeasons e fetchSnapshot da mesma execucao usam o mesmo contexto.
    const memo = indexMemo.get(ctx);
    if (memo?.base === series.base) return memo.html;
  }
  const url = !season ? series.base : event ? eventUrl(series, season, event) : seasonUrl(series, season);
  for (const encoding of ['identity', 'deflate', 'identity']) {
    const html = await ctx.http.text(url, { headers: { 'accept-encoding': encoding } });
    const got = (name: string) => parseSelect(html, name).find((o) => o.selected)?.value;
    if ((!season || got('season') === season) && (!event || got('evvent') === event)) {
      if (!season) indexMemo.set(ctx, { base: series.base, html });
      return html;
    }
  }
  throw new Error(`Al Kamel devolveu outra pagina para ${url} (cache da CDN)`);
}

/** Fim de semana da serie principal (treino, classificacao ou corrida), fora testes. */
function isRaceWeekend(ev: EventInfo): boolean {
  return ev.main && !/\b(test|roar|prologue)\b/i.test(ev.label) &&
    (ev.race !== null || ev.sessions.some((s) => /^(race|qualifying|hyperpole|free practice|practice)\b/i.test(s)));
}

async function listSeasonsFor(series: Series, ctx: AdapterContext): Promise<number[]> {
  const html = await getPage(series, ctx);
  const options = parseSelect(html, 'season');
  const latest = options.find((o) => o.selected) ?? options.at(-1);
  const years = new Set<number>();
  for (const o of options) {
    const y = seasonYear(o.label);
    if (y && o !== latest) years.add(y);
  }
  // A temporada mais nova so conta quando ja tem um fim de semana de corrida
  // (no fim do ano a Al Kamel abre a seguinte so com testes).
  if (latest && seasonYear(latest.label)) {
    const confirmed = (ctx.params.confirmedSeasons as string[] | undefined) ?? [];
    let ok = confirmed.includes(latest.value);
    if (!ok) {
      const events = parseSelect(html, 'evvent');
      const selected = events.find((e) => e.selected);
      ok = selected ? isRaceWeekend(parseEvent(html, series, latest.value, selected.value, selected.label)) : false;
      for (const e of events) {
        if (ok) break;
        if (e === selected) continue;
        try {
          ok = isRaceWeekend(parseEvent(await getPage(series, ctx, latest.value, e.value), series, latest.value, e.value, e.label));
        } catch {
          break; // fonte instavel: confirma numa proxima execucao
        }
      }
      if (ok) ctx.params.confirmedSeasons = [...confirmed, latest.value].slice(-3);
    }
    if (ok) years.add(seasonYear(latest.label)!);
  }
  return [...years].sort((a, b) => a - b);
}

/** Le as paginas de todos os eventos da temporada (as encerradas vem do cache em params). */
async function loadEvents(series: Series, ctx: AdapterContext, season: number): Promise<EventInfo[]> {
  const index = await getPage(series, ctx);
  const option = parseSelect(index, 'season').find((o) => seasonYear(o.label) === season);
  if (!option) throw new Error(`Temporada ${season} nao aparece em ${series.base}`);
  const page = option.selected ? index : await getPage(series, ctx, option.value);
  const options = parseSelect(page, 'evvent');
  const selected = options.find((o) => o.selected);
  const key = `events:${option.value}`;
  const cache = (ctx.params[key] ?? {}) as Record<string, EventInfo>;
  const events = await mapLimit(options, 4, async (o) => {
    if (cache[o.value]) return cache[o.value];
    const html = o === selected ? page : await getPage(series, ctx, option.value, o.value);
    return parseEvent(html, series, option.value, o.value, o.label);
  });
  const old = (ev: EventInfo) => ev.lastTs !== null && ctx.now.getTime() - tsTime(ev.lastTs) > 10 * 86_400_000;
  for (const k of Object.keys(ctx.params)) if (k.startsWith('events:')) delete ctx.params[k];
  const keep = events.filter((ev) => old(ev) && series.settled(ev));
  if (keep.length) ctx.params[key] = Object.fromEntries(keep.map((ev) => [ev.value, ev]));
  return events;
}

async function fetchAll(ctx: AdapterContext, base: string, hrefs: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(hrefs)];
  const bodies = await mapLimit(unique, 4, (h) => ctx.http.text(base + h));
  return new Map(unique.map((h, i) => [h, bodies[i]]));
}

const crewName = (drivers: string[]) => drivers.join(' / ');

/** Uma linha por piloto, todas com os dados do carro. */
function perDriver(car: Omit<ResultRow, 'driver'>, drivers: string[]): ResultRow[] {
  return drivers.map((driver) => ({ ...car, driver }));
}

// Nome curto para o app. Ordem importa: "Lone Star Le Mans" e Austin, nao Le Mans.
const SHORT_NAMES: [RegExp, string][] = [
  [/lone.?star|americas|\bcota\b|austin/, 'Austin'],
  [/sao.?paulo|interlagos/, 'Interlagos'],
  [/petit.?le.?mans|road.?atlanta|michelin.?raceway/, 'Road Atlanta'],
  [/le.?mans|sarthe/, 'Le Mans'],
  [/imola/, 'Imola'],
  [/spa/, 'Spa'],
  [/fuji/, 'Fuji'],
  [/barcelona|catalunya/, 'Barcelona'],
  [/monza/, 'Monza'],
  [/losail|qatar|lusail/, 'Catar'],
  [/bahrain|sakhir/, 'Bahrein'],
  [/silverstone/, 'Silverstone'],
  [/daytona/, 'Daytona'],
  [/sebring/, 'Sebring'],
  [/long.?beach/, 'Long Beach'],
  [/laguna.?seca|monterey/, 'Laguna Seca'],
  [/detroit/, 'Detroit'],
  [/watkins.?glen/, 'Watkins Glen'],
  [/canadian.?tire|mosport|ctmp/, 'Mosport'],
  [/road.?america|elkhart/, 'Road America'],
  [/virginia|\bvir\b/, 'VIR'],
  [/indianapolis/, 'Indianapolis'],
  [/mid.?ohio/, 'Mid-Ohio'],
  [/lime.?rock/, 'Lime Rock'],
];

export function shortName(...texts: (string | null | undefined)[]): string {
  const hay = texts.filter(Boolean).join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const [re, name] of SHORT_NAMES) if (re.test(hay)) return name;
  const label = texts.find(Boolean) ?? '';
  return titleName(label.replace(/^\d+_/, '').replace(/\(.*?\)/g, '').replace(/\b(international|speedway|raceway|street|course|circuit|motor)\b/gi, '').trim()) ||
    label;
}

// ---------------------------------------------------------------------------
// WEC

const WEC_CLASSES = ['HYPERCAR', 'LMGT3'];
const FIAWEC = 'https://www.fiawec.com';
const LE_MANS_ID = /-le-mans$/;
/**
 * O fator 2x de Le Mans vale para toda sessao da corrida, mas a pole continua
 * valendo 1 ponto (conferido na tabela oficial). Por isso a pole de Le Mans
 * vai numa sessao propria que vale 0,5 x 2.
 */
const POLE_DOUBLE = 'pole-le-mans';

const WEC_RULES: PointsRules = {
  sessions: { race: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], pole: [1], [POLE_DOUBLE]: [0.5] },
  multipliers: { [`/${LE_MANS_ID.source}/`]: 2 },
  perClass: true,
  classGroupNames: { HYPERCAR: 'drivers' },
};

const wecSeries: Series = {
  base: 'https://fiawec.alkamelsystems.com/',
  main: /^\d+_FIA WEC$/,
  raceSession: /^Race$/i,
  raceFile: /^03_Classification_Race.*\.CSV$/i,
  qualiSession: /^(Hyperpole|Qualifying)\b/i,
  qualiFile: /^03_Classification_.*\.CSV$/i,
  rank(path) {
    const mark = /amended|revised/i.test(path) ? 3 : /_Final/i.test(path) ? 2 : 1;
    return mark * 100 + Number(path.match(/Hour (\d+)/i)?.[1] ?? 0);
  },
  isOfficial: (file) => /_Final/i.test(file),
  settled: (ev) => !ev.race || ev.points,
};

export interface CalendarEntry {
  slug: string;
  enName: string;
  date: string;
}

/**
 * Calendario do menu de fiawec.com (dia/mes de cada etapa, inclusive futuras).
 * Sem horario: o contador da pagina marca o inicio do fim de semana, nao a largada.
 */
export function parseFiawecCalendar(html: string, season: number): CalendarEntry[] {
  const names = new Map<string, string>();
  for (const chunk of html.split('<div class="race-item">').slice(1)) {
    const name = chunk.match(/<span class="name">([^<]*)<\/span>/)?.[1];
    const href = chunk.match(/href="\/en\/race\/([a-z0-9-]+)"/)?.[1];
    if (name && href && !names.has(href)) names.set(href, decodeHtml(name));
  }
  const out = new Map<string, CalendarEntry>();
  const re = /href="\/en\/race\/([a-z0-9-]+-(\d{4}))"\s*>\s*<span class="flag:[^"]*"><\/span>\s*<span[^>]*>[^<]*<\/span>\s*<div[^>]*>\s*<strong[^>]*>(\d{1,2})<\/strong>\s*<small[^>]*>([A-Za-z]{3})/g;
  for (const m of html.matchAll(re)) {
    const [, slug, year, day, mon] = m;
    if (Number(year) !== season || out.has(slug) || /prologue|test|rookie/.test(slug)) continue;
    const month = MONTHS[mon.toLowerCase()];
    if (!month) continue;
    out.set(slug, {
      slug,
      enName: names.get(slug) ?? titleName(slug.replace(/-\d{4}$/, '').replace(/-/g, ' ').toUpperCase()),
      date: `${year}-${pad(month)}-${pad(Number(day))}`,
    });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface SiteStanding {
  title: string;
  /** Etapas ja pontuadas (colunas preenchidas). */
  races: number;
  rows: { position: number; number: string; drivers: string[]; points: number }[];
}

/** Tabelas de classificacao de fiawec.com/en/season/<ano> (uma linha por carro/grupo de pilotos). */
export function parseFiawecStandings(html: string): SiteStanding[] {
  const out: SiteStanding[] = [];
  for (const chunk of html.split('data-bs-target="#results-').slice(1)) {
    const title = chunk.match(/^\d+">([^<]*)<\/button>/)?.[1];
    const body = chunk.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
    if (!title || !body) continue;
    const set: SiteStanding = { title: decodeHtml(title), races: 0, rows: [] };
    for (const tr of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      if (cells.length < 5) continue;
      const text = (c: string) => decodeHtml(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      const drivers = [...cells[3].matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((a) => titleName(decodeHtml(a[1]))).filter(Boolean);
      const position = Number(text(cells[0]));
      const points = Number(text(cells[cells.length - 1]));
      if (!drivers.length || !Number.isFinite(position) || !Number.isFinite(points)) continue;
      if (!set.rows.length) set.races = cells.slice(4, -1).filter((c) => /\d/.test(text(c))).length;
      set.rows.push({ position, number: text(cells[2]).replace(/^#/, ''), drivers, points });
    }
    if (set.rows.length) out.push(set);
  }
  return out;
}

/** Uma linha por piloto; pilotos do mesmo carro dividem a posicao. */
function expandStanding(set: SiteStanding, group: string, canon: Map<string, { name: string; team: string | null }>, asOf: number | null): StandingsSet {
  const rows: StandingRow[] = [];
  for (const car of [...set.rows].sort((a, b) => a.position - b.position)) {
    const position = rows.length + 1;
    for (const d of car.drivers) {
      const known = canon.get(normKey(d));
      rows.push({ position, name: known?.name ?? d, team: known?.team ?? null, points: car.points });
    }
  }
  return { group, asOfRound: asOf, rows };
}

function wecRaceRows(csv: string): { rows: ResultRow[]; crews: Map<string, string[]> } {
  const rows: ResultRow[] = [];
  const crews = new Map<string, string[]>();
  for (const r of parseCsv(csv)) {
    const cls = (r.CLASS ?? '').toUpperCase();
    if (!WEC_CLASSES.includes(cls)) continue;
    const drivers = [1, 2, 3, 4, 5, 6].map((i) => r[`DRIVER_${i}`]).filter(Boolean).map(titleName);
    crews.set(r.NUMBER, drivers);
    const classified = /^classified$/i.test(r.STATUS ?? '');
    const position = classified && Number(r.POSITION) > 0 ? Number(r.POSITION) : null;
    rows.push(...perDriver({ position, team: r.TEAM || null, number: r.NUMBER, class: cls, status: r.STATUS || null, laps: Number(r.LAPS) || null }, drivers));
  }
  return { rows, crews };
}

/** Sessao que define a pole de cada classe: a ultima Hyperpole (ou o Qualifying, se nao houve Hyperpole). */
function poleFile(ev: EventInfo, cls: string): FileRef | null {
  const fits = (s: string) => s.toUpperCase().includes(cls) || !WEC_CLASSES.some((c) => s.toUpperCase().includes(c));
  const score = (s: string) => (/hyperpole/i.test(s) ? 10 + Number(s.match(/hyperpole\s*(\d)/i)?.[1] ?? 0) : 0);
  const options = ev.quali.filter((q) => fits(q.session)).sort((a, b) => score(b.session) - score(a.session) || b.ts.localeCompare(a.ts));
  return options[0] ?? null;
}

function polePosition(csv: string, cls: string, guests: Set<string>): { number: string; drivers: string[] } | null {
  const rows = parseCsv(csv)
    .filter((r) => (r.CLASS ?? '').toUpperCase() === cls && Number(r.POS) > 0 && r.TIME && !guests.has(`${cls}#${r.NUMBER}`))
    .sort((a, b) => Number(a.POS) - Number(b.POS));
  const top = rows[0];
  if (!top) return null;
  const drivers = [1, 2, 3, 4, 5, 6]
    .map((i) => [top[`DRIVER${i}_FIRSTNAME`], top[`DRIVER${i}_SECONDNAME`]].filter(Boolean).join(' '))
    .filter(Boolean)
    .map(titleName);
  return { number: top.NUMBER, drivers };
}

async function wecSnapshot(ctx: AdapterContext, season: number): Promise<Snapshot> {
  const notes: string[] = [];
  const events = (await loadEvents(wecSeries, ctx, season)).filter(isRaceWeekend);
  const evDate = (ev: EventInfo) => tsDate(ev.race?.ts ?? ev.lastTs ?? `${season}0101`);

  let calendar: CalendarEntry[] = [];
  let site: SiteStanding[] | null = null;
  try {
    const html = await ctx.http.text(`${FIAWEC}/en/season/${season}`);
    calendar = parseFiawecCalendar(html, season);
    site = parseFiawecStandings(html);
    if (!calendar.length) notes.push('fiawec.com sem calendario legivel; usando so as etapas da Al Kamel.');
  } catch (error) {
    notes.push(`fiawec.com indisponivel (${error instanceof Error ? error.message : error}); calendario so com as etapas da Al Kamel e sem classificacao oficial.`);
  }

  // Junta calendario (fiawec.com) e eventos da Al Kamel pela data.
  type Entry = { cal: CalendarEntry | null; ev: EventInfo | null; date: string };
  const entries: Entry[] = calendar.map((cal) => ({ cal, ev: null, date: cal.date }));
  for (const ev of events) {
    const d = evDate(ev);
    const hit = entries.find((e) => !e.ev && e.cal && (ev.race ? Math.abs(dayDiff(d, e.cal.date)) <= 3 : dayDiff(e.cal.date, d) >= 0 && dayDiff(e.cal.date, d) <= 4));
    if (hit) hit.ev = ev;
    else if (ev.race) entries.push({ cal: null, ev, date: d });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));

  const done = (ev: EventInfo | null) =>
    !!ev?.race && (ev.race.official || ev.points || ctx.now.getTime() - tsTime(ev.race.ts) > 30 * 3600_000);
  const finished = entries.filter((e) => done(e.ev));
  const poles = new Map(finished.map((e) => [e.ev!, WEC_CLASSES.map((cls) => ({ cls, file: poleFile(e.ev!, cls) }))]));
  const files = await fetchAll(ctx, wecSeries.base, [
    ...finished.map((e) => e.ev!.race!.href),
    ...[...poles.values()].flat().flatMap((p) => (p.file ? [p.file.href] : [])),
  ]);

  // Le Mans tem convidados do ACO que nao disputam o WEC: so pontua quem tambem
  // aparece em outra etapa. Eles ficam no resultado, mas sem posicao para pontos.
  const parsed = new Map(finished.map((e) => [e, wecRaceRows(files.get(e.ev!.race!.href)!)]));
  const carKey = (r: ResultRow) => `${r.class}#${r.number}`;
  const guestsOf = (entry: Entry) => {
    const others = new Set([...parsed].filter(([e]) => e !== entry).flatMap(([, p]) => p.rows.map(carKey)));
    return new Set(parsed.get(entry)!.rows.map(carKey).filter((k) => !others.has(k)));
  };

  const races: RaceRecord[] = [];
  const results: RaceResult[] = [];
  entries.forEach((entry, i) => {
    const round = i + 1;
    const { ev, cal } = entry;
    const name = shortName(ev?.label, cal?.enName, cal?.slug);
    const raceId = `r${pad(round)}-${slugify(name)}`;
    const record: RaceRecord = {
      raceId, round, name,
      enName: cal?.enName ?? (ev ? titleName(ev.label.replace(/^\d+_/, '')) : null),
      circuit: ev ? titleName(ev.label.replace(/^\d+_/, '')) : null,
      date: ev?.race ? tsDate(ev.race.ts) : entry.date,
      status: 'upcoming',
      winner: null,
      externalId: ev?.value ?? cal?.slug ?? null,
      sourceUrl: ev ? eventUrl(wecSeries, ev.season, ev.value) : cal ? `${FIAWEC}/en/race/${cal.slug}` : null,
    };
    races.push(record);
    if (!done(ev)) return;
    const { rows, crews } = parsed.get(entry)!;
    const official = ev!.points || ev!.race!.official;
    record.status = 'completed';
    record.official = official;
    const top = rows.filter((r) => r.class === WEC_CLASSES[0] && r.position != null).sort((a, b) => a.position! - b.position!)[0];
    record.winner = top ? crewName(crews.get(top.number!) ?? [top.driver]) : null;
    const guests = LE_MANS_ID.test(raceId) && parsed.size > 1 ? guestsOf(entry) : new Set<string>();
    for (const r of rows) {
      if (guests.has(carKey(r))) Object.assign(r, { position: null, status: `${r.status ?? ''} (convidado, fora do WEC)`.trim() });
    }
    results.push({ raceId, session: 'race', official, rows });

    const poleRows: ResultRow[] = [];
    for (const { cls, file } of poles.get(ev!)!) {
      const pole = file ? polePosition(files.get(file.href)!, cls, guests) : null;
      if (!pole) continue;
      const drivers = crews.get(pole.number) ?? pole.drivers;
      poleRows.push(...perDriver({ position: 1, number: pole.number, class: cls, team: rows.find((r) => r.number === pole.number)?.team ?? null }, drivers));
    }
    if (poleRows.length) results.push({ raceId, session: LE_MANS_ID.test(raceId) ? POLE_DOUBLE : 'pole', official, rows: poleRows });
    else notes.push(`${name}: sem classificacao/Hyperpole na Al Kamel; ninguem ganhou ponto de pole.`);
  });

  // Classificacao oficial (fiawec.com), com o nome escrito como nos resultados.
  const canon = new Map<string, { name: string; team: string | null }>();
  for (const res of results) for (const r of res.rows) if (res.session === 'race') canon.set(normKey(r.driver), { name: r.driver, team: r.team ?? null });
  const officialStandings: StandingsSet[] = [];
  for (const set of site ?? []) {
    const group = /hypercar.*drivers/i.test(set.title) ? 'drivers' : /lmgt3 drivers/i.test(set.title) ? 'class:LMGT3' : null;
    if (group && !officialStandings.some((s) => s.group === group)) officialStandings.push(expandStanding(set, group, canon, set.races || null));
  }
  if (site && !officialStandings.length && results.length) notes.push('fiawec.com sem classificacao de pilotos legivel; vale a calculada.');
  return { season, races, results, officialStandings, notes };
}

export const wec: AdapterWithRules = {
  id: 'wec',
  source: 'fiawec.alkamelsystems.com + fiawec.com',
  staleAfterHours: 30,
  rules: { 2026: WEC_RULES },
  listSeasons: (ctx) => listSeasonsFor(wecSeries, ctx),
  fetchSnapshot: wecSnapshot,
};

// ---------------------------------------------------------------------------
// IMSA

const IMSA_CLASSES = ['GTP', 'LMP2', 'GTDPRO', 'GTD'];

// Tabela do regulamento IMSA (pontos por posicao na classe, 1o ao 30o).
const IMSA_RACE = [350, 320, 300, 280, 260, ...Array.from({ length: 25 }, (_, i) => 250 - i * 10)];
const IMSA_QUALI = [35, 32, 30, 28, 26, ...Array.from({ length: 25 }, (_, i) => 25 - i)];

const IMSA_RULES: PointsRules = {
  sessions: { race: IMSA_RACE, qualifying: IMSA_QUALI },
  perClass: true,
  classGroupNames: { GTP: 'drivers' },
};

const MARKS: [RegExp, number][] = [[/official/i, 4], [/provisional/i, 3], [/unofficial/i, 2]];
const imsaSeries: Series = {
  base: 'https://imsa.results.alkamelcloud.com/',
  main: /^\d+_IMSA WeatherTech SportsCar Championship$/,
  raceSession: /^Race$/i,
  raceFile: /^03_Results_Race.*\.JSON$/i,
  qualiSession: /^Qualifying\b/i,
  qualiFile: /^03_Results_Qualifying.*\.JSON$/i,
  gridFile: /^02_Grid_Race.*\.CSV$/i,
  rank(path) {
    // "Unofficial" contem "official": testa as marcas na ordem certa.
    const file = path.split('/').pop() ?? '';
    const mark = /unofficial/i.test(file) ? 2 : MARKS.find(([re]) => re.test(file))?.[1] ?? 1;
    return mark * 10 + (/revised|amended/i.test(file) ? 1 : 0);
  },
  isOfficial: (file) => /_official/i.test(file),
  settled: (ev) => !ev.race || ev.race.official,
};

interface ImsaJson {
  session?: { event_name?: string; circuit?: { name?: string } };
  classification?: {
    position?: number | string | null;
    number?: string;
    status?: string;
    time?: string;
    laps?: string | number;
    team?: string;
    class?: string;
    drivers?: { firstname?: string; surname?: string }[];
  }[];
}

type ImsaCar = NonNullable<ImsaJson['classification']>[number];
const byPosition = (a: ImsaCar, b: ImsaCar) => (Number(a.position) || Infinity) - (Number(b.position) || Infinity);
const imsaCar = (c: ImsaCar, position: number | null): ResultRow[] =>
  perDriver(
    { position, team: c.team || null, number: c.number ?? null, class: (c.class ?? '').toUpperCase(), status: c.status || null, laps: Number(c.laps) || null },
    (c.drivers ?? []).map((d) => `${d.firstname ?? ''} ${d.surname ?? ''}`.trim()).filter(Boolean),
  );

/** "1:34.041" -> 94.041 */
function lapSeconds(t: string | undefined): number | null {
  if (!t || !/^\d+(:\d+)*(\.\d+)?$/.test(t.trim())) return null;
  return t.trim().split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Corrida: posicao geral; quem nao largou (DNS) ou foi excluido nao pontua. */
function imsaRaceRows(data: ImsaJson): ResultRow[] {
  return [...(data.classification ?? [])]
    .sort(byPosition)
    .filter((c) => IMSA_CLASSES.includes((c.class ?? '').toUpperCase()))
    .flatMap((c) => imsaCar(c, Number(c.position) > 0 && !/not started|dns|did not start|excluded|disq|dsq/i.test(c.status ?? '') ? Number(c.position) : null));
}

/**
 * Classificacao (qualifying). O JSON da Al Kamel e "Unofficial" e nao traz as
 * punicoes posteriores; o grid oficial traz o tempo que valeu. Ordem por classe:
 * tempo do grid, depois quem foi a pista sem tempo valido (pontua como ultimo).
 * Classe sem nenhum tempo na sessao ou no grid oficial (classificacao
 * cancelada/anulada, ex.: GTD em Watkins Glen 2026) nao pontua.
 */
function imsaQualiRows(sessions: ImsaJson[], grid: Map<string, number> | null): ResultRow[] {
  const seen = new Set<string>();
  const cars = sessions.flatMap((d) => [...(d.classification ?? [])].sort(byPosition)).filter((c) => {
    const key = `${c.class}#${c.number}`;
    return !seen.has(key) && seen.add(key);
  });
  const rows: ResultRow[] = [];
  let n = 0;
  for (const cls of IMSA_CLASSES) {
    const inClass = cars.filter((c) => (c.class ?? '').toUpperCase() === cls);
    const gridTime = (c: ImsaCar) => grid?.get(c.number ?? '') ?? null;
    const timed = inClass.some((c) => lapSeconds(c.time) != null) && (!grid || inClass.some((c) => gridTime(c) != null));
    const ordered = grid
      ? [...inClass.filter((c) => gridTime(c) != null).sort((a, b) => gridTime(a)! - gridTime(b)!), ...inClass.filter((c) => gridTime(c) == null)]
      : inClass;
    for (const c of ordered) rows.push(...imsaCar(c, timed ? ++n : null));
  }
  return rows;
}

function parseGrid(csv: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of parseCsv(csv)) {
    const t = lapSeconds(r.TIME);
    if (r.NUMBER && t != null) out.set(r.NUMBER, t);
  }
  return out;
}

async function imsaSnapshot(ctx: AdapterContext, season: number): Promise<Snapshot> {
  const notes = ['Calendario IMSA so com os eventos que ja estao na Al Kamel (imsa.com bloqueia robos).'];
  const events = (await loadEvents(imsaSeries, ctx, season)).filter(isRaceWeekend);
  const finished = events.filter((ev) => ev.race);
  const files = await fetchAll(
    ctx,
    imsaSeries.base,
    finished.flatMap((ev) => [ev.race!.href, ...ev.quali.map((q) => q.href), ...(ev.grid ? [ev.grid.href] : [])]),
  );
  const parse = (href: string) => JSON.parse(files.get(href)!.replace(/^﻿/, '')) as ImsaJson;

  const races: RaceRecord[] = [];
  const results: RaceResult[] = [];
  events.forEach((ev, i) => {
    const round = i + 1;
    const name = shortName(ev.label);
    const raceId = `r${pad(round)}-${slugify(name)}`;
    const record: RaceRecord = {
      raceId, round, name,
      enName: null,
      circuit: ev.label.replace(/^\d+_/, ''),
      date: tsDate(ev.race?.ts ?? ev.lastTs ?? `${season}0101`),
      status: 'upcoming',
      winner: null,
      externalId: ev.value,
      sourceUrl: eventUrl(imsaSeries, ev.season, ev.value),
    };
    races.push(record);
    if (!ev.race) return;
    const data = parse(ev.race.href);
    record.enName = data.session?.event_name ?? null;
    record.circuit = data.session?.circuit?.name ?? record.circuit;
    record.status = 'completed';
    record.official = ev.race.official;
    const rows = imsaRaceRows(data);
    const topClass = IMSA_CLASSES.find((c) => rows.some((r) => r.class === c && r.position != null));
    const top = rows.filter((r) => r.class === topClass && r.position != null).sort((a, b) => a.position! - b.position!)[0];
    record.winner = top ? crewName(rows.filter((r) => r.number === top.number).map((r) => r.driver)) : null;
    results.push({ raceId, session: 'race', official: ev.race.official, rows });

    const quali = imsaQualiRows(ev.quali.map((q) => parse(q.href)), ev.grid ? parseGrid(files.get(ev.grid.href)!) : null);
    if (quali.length) results.push({ raceId, session: 'qualifying', official: ev.race.official, rows: quali });
    else notes.push(`${name}: sem resultado de classificacao na Al Kamel; sem pontos de classificacao.`);
  });
  if (results.length) notes.push('Classificacao oficial da IMSA so sai em PDF; publicada a calculada (corrida + classificacao, por classe).');
  return { season, races, results, officialStandings: [], notes };
}

export const imsa: AdapterWithRules = {
  id: 'imsa',
  source: 'imsa.results.alkamelcloud.com',
  staleAfterHours: 30,
  rules: { 2026: IMSA_RULES },
  listSeasons: (ctx) => listSeasonsFor(imsaSeries, ctx),
  fetchSnapshot: imsaSnapshot,
};
