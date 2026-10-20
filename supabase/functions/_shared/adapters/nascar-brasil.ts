import type { AdapterContext, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// NASCAR Brasil pelo site da CBA (cba.org.br). O site oficial da categoria
// fica atras de desafio anti-robo, entao nao e usado.
//
// A CBA publica, por piloto: pontos de cada prova (2 por etapa, com data),
// "Ganhos Extras" da etapa, descarte e total. Nao publica a ordem de chegada:
// o vencedor de cada prova e quem fez 25 pontos (tabela 2026), so quando
// houver exatamente um. A posicao so e preenchida para quem pontuou com valor
// unico na tabela; o resto fica sem posicao.
//
// Filtros (temporada, campeonato, subcategoria) vao por POST no formulario da
// pagina; a lista de pilotos vem de 10 em 10 (offset no fim da URL).

const BASE = 'https://cba.org.br/campeonato';
const STANDINGS = `${BASE}/classificacao/330/50/nascar-brasil-sprint-nbsp-race`;
const CALENDAR = `${BASE}/calendario/330/531/nascar-brasil-sprint-nbsp-race`;
const PAGE_SIZE = 10;
const MAX_PAGES = 8;

/** Tabela de pontos por prova (regulamento 2026): o vencedor faz 25. */
export const RACE_POINTS = [25, 20, 16, 14, 12, 10, 8, 6, 4, 3, 2, 1];

const MONTHS: Record<string, number> = {
  jan: 1,
  fev: 2,
  mar: 3,
  abr: 4,
  mai: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  set: 9,
  out: 10,
  nov: 11,
  dez: 12,
};

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = (s: string) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pad = (n: number) => String(n).padStart(2, '0');
const squash = (html: string) => html.replace(/\s+/g, ' ');
const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
const brDate = (s: string) => {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

interface FormInfo {
  years: number[];
  selectedYear: number | null;
  idClass: string | null;
  idSub: string | null;
}

interface StageCell {
  city: string | null;
  provas: { n: number; date: string | null; points: number | null; code: string | null }[];
  extra: number;
}

interface DriverRow {
  position: number;
  name: string;
  stages: StageCell[];
  discard: number;
  total: number;
}

function options(html: string, name: string): { value: string; text: string; selected: boolean }[] {
  const m = html.match(new RegExp(`<select name=['"]${name}['"][^>]*>(.*?)</select>`));
  if (!m) return [];
  return [...m[1].matchAll(/<option\s*(selected)?\s*value=['"]([^'"]*)['"]\s*>([^<]*)/g)].map((o) => ({
    value: o[2],
    text: decode(o[3]),
    selected: !!o[1],
  }));
}

export function parseForm(raw: string): FormInfo {
  const html = squash(raw);
  const years = options(html, 'anoTemporada');
  const classes = options(html, 'idClass');
  const subs = options(html, 'idSub');
  // Campeonato principal (nao o "Special Edition") e a subcategoria geral "Nascar Brasil".
  const cls = classes.find((o) => /sprint race/i.test(o.text)) ?? classes.find((o) => o.selected) ?? classes[0];
  const sub = subs.find((o) => /^nascar brasil$/i.test(o.text)) ?? subs[0];
  return {
    years: years.map((o) => Number(o.value)).filter((y) => y > 2000),
    selectedYear: Number(years.find((o) => o.selected)?.value) || null,
    idClass: cls?.value ?? null,
    idSub: sub?.value ?? null,
  };
}

export function parseCalendar(raw: string, season: number): { city: string; date: string }[] {
  const html = squash(raw);
  const list = html.slice(html.indexOf('</form>'));
  const out: { city: string; date: string }[] = [];
  for (const m of list.matchAll(/class='semana'>([^<]*)<\/span>\s*<span class='dia'>(\d{1,2})<.*?class='cidade'>([^<]*)</g)) {
    const month = MONTHS[plain(m[1]).toLowerCase().slice(0, 3)];
    if (!month) continue;
    out.push({ city: decode(m[3]), date: `${season}-${pad(month)}-${pad(Number(m[2]))}` });
  }
  return out;
}

export function parseStandings(raw: string): DriverRow[] {
  const html = squash(raw);
  const body = html.slice(html.indexOf("class='itensTH'"));
  const rows: DriverRow[] = [];
  for (const chunk of body.split(/<ul\s*><li class='pos'>/).slice(1)) {
    const position = Number(chunk.match(/<h3>\s*(\d+)/)?.[1]);
    const name = decode(chunk.match(/<h4>([^<]*)/)?.[1] ?? '');
    if (!position || !name) continue;
    const cells = chunk.split(/<li class='temporada'\s*>/).slice(1);
    const stages: StageCell[] = [];
    let discard = 0;
    let total = NaN;
    for (const cell of cells) {
      const fin = cell.match(/class='final'>\s*([-\d.,]+)/);
      if (fin) {
        total = Number(fin[1].replace(',', '.'));
        continue;
      }
      const desc = cell.match(/class='desc'>\s*-?\s*([\d.,]*)/);
      if (desc && !cell.includes('moreInfo')) {
        discard = Number(desc[1].replace(',', '.')) || 0;
        continue;
      }
      const provas = [
        ...cell.matchAll(
          /class='prova'>\s*(\d+)\D{0,3}\s*Prova\s*<br>\s*<span class='local'>([^<]*)<\/span><\/span>\s*<span class='resultado'>\s*([^<]*)/g,
        ),
      ].map(
        (m) => {
          const value = m[3].trim();
          const points = /^-?[\d.,]+$/.test(value) ? Number(value.replace(',', '.')) : null;
          return { n: Number(m[1]), date: brDate(m[2]), points, code: points == null ? value || null : null };
        },
      );
      const extra = cell.match(/Ganhos Extras<\/span><\/div>\s*<span class='resultado'>\s*\d+\s*<small>\(\s*([\d.,]+)/);
      stages.push({
        city: decode(cell.match(/class='cidade'>([^<]*)/)?.[1] ?? '') || null,
        provas,
        extra: extra ? Number(extra[1].replace(',', '.')) : 0,
      });
    }
    rows.push({ position, name, stages, discard, total });
  }
  return rows;
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

async function seasonForm(ctx: AdapterContext, season: number): Promise<FormInfo> {
  return parseForm(await ctx.http.text(STANDINGS, form({ anoTemporada: String(season) })));
}

export const adapter: AdapterWithRules = {
  id: 'nascar-brasil',
  source: 'cba.org.br (classificacao CBA)',
  // A CBA atualiza a tabela uns dias depois da etapa.
  staleAfterHours: 96,

  async listSeasons(ctx) {
    const info = parseForm(await ctx.http.text(STANDINGS));
    const year = ctx.now.getUTCFullYear();
    const out: number[] = [];
    for (const y of info.years.filter((y) => y >= year - 1)) {
      if (y <= year) {
        out.push(y);
        continue;
      }
      // Ano futuro so conta com calendario publicado.
      try {
        const f = await seasonForm(ctx, y);
        const fields = { anoTemporada: String(y), idClass: f.idClass ?? '', idSub: f.idSub ?? '' };
        if (parseCalendar(await ctx.http.text(CALENDAR, form(fields)), y).length) out.push(y);
      } catch {
        // ainda nao publicado
      }
    }
    return out.sort((a, b) => a - b);
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const info = await seasonForm(ctx, season);
    if (!info.years.includes(season)) throw new Error(`CBA nao lista a temporada ${season}.`);
    const fields = { anoTemporada: String(season), idClass: info.idClass ?? '', idSub: info.idSub ?? '' };

    const calendar = parseCalendar(await ctx.http.text(CALENDAR, form(fields)), season);

    const drivers: DriverRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = page === 0 ? STANDINGS : `${STANDINGS}/${page * PAGE_SIZE}`;
      const rows = parseStandings(await ctx.http.text(url, form(fields)));
      for (const r of rows) if (!drivers.some((d) => d.name === r.name)) drivers.push(r);
      if (rows.length < PAGE_SIZE) break;
    }

    // Etapas: calendario da CBA; colunas da classificacao na mesma ordem (confere pela cidade).
    const columns = drivers[0]?.stages.map((s) => s.city) ?? [];
    const stages = calendar.length ? calendar : columns.map((city, i) => {
      const date = drivers.flatMap((d) => d.stages[i]?.provas ?? []).find((p) => p.date)?.date ?? null;
      return { city: city ?? `Etapa ${i + 1}`, date: date ?? '' };
    }).filter((s) => s.date);
    if (!calendar.length) notes.push('Calendario da CBA vazio; etapas montadas pela classificacao (so as que ja tem data).');
    const used = new Set<number>();
    const columnFor = (city: string, i: number) => {
      const same = (c: string | null) => !!c && slug(c) === slug(city);
      const idx = same(columns[i]) && !used.has(i) ? i : columns.findIndex((c, j) => same(c) && !used.has(j));
      if (idx >= 0) used.add(idx);
      return idx;
    };

    const races: RaceRecord[] = [];
    const results: RaceResult[] = [];
    stages.forEach((stage, i) => {
      const round = i + 1;
      const raceId = `r${pad(round)}-${slug(stage.city)}`;
      const col = columnFor(stage.city, i);
      const cells = col >= 0 ? drivers.map((d) => ({ d, cell: d.stages[col] })) : [];
      const provaNumbers = [...new Set(cells.flatMap(({ cell }) => cell?.provas.map((p) => p.n) ?? []))].sort((a, b) => a - b);
      const winners: string[] = [];
      let missing = 0;
      let date = stage.date;
      for (const n of provaNumbers) {
        const entries = cells
          .map(({ d, cell }) => ({ d, p: cell?.provas.find((p) => p.n === n) }))
          .filter((e): e is { d: DriverRow; p: StageCell['provas'][number] } => !!e.p);
        if (!entries.some((e) => e.p.points != null)) continue;
        const provaDate = entries.find((e) => e.p.date)?.p.date;
        if (provaDate && provaDate > date) date = provaDate;
        const count = new Map<number, number>();
        for (const e of entries) if (e.p.points != null) count.set(e.p.points, (count.get(e.p.points) ?? 0) + 1);
        const top = entries.filter((e) => e.p.points === RACE_POINTS[0]);
        if (top.length === 1) winners.push(top[0].d.name);
        else missing++;
        const rows: ResultRow[] = entries
          .map((e) => {
            const idx = e.p.points ? RACE_POINTS.indexOf(e.p.points) : -1;
            return {
              position: idx >= 0 && count.get(e.p.points!) === 1 ? idx + 1 : null,
              driver: e.d.name,
              status: e.p.code,
              points: e.p.points ?? 0,
            };
          })
          .sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || a.driver.localeCompare(b.driver));
        results.push({ raceId, session: `race${n}`, official: true, rows });
      }
      const completed = results.some((r) => r.raceId === raceId);
      if (completed) {
        // Ganhos extras nao tem prova: entram como sessao "bonus" para a soma bater com o total.
        const rows = cells.filter(({ cell }) => cell?.extra).map(({ d, cell }) => ({
          position: null,
          driver: d.name,
          points: cell!.extra,
        }));
        results.push({ raceId, session: 'bonus', official: true, rows });
        if (missing) notes.push(`${stage.city}: vencedor de ${missing} prova(s) nao identificado pelos pontos.`);
      }
      const unique = [...new Set(winners)];
      races.push({
        raceId,
        round,
        name: stage.city,
        enName: `Etapa ${pad(round)} - ${stage.city}`,
        location: stage.city,
        date,
        status: completed ? 'completed' : 'upcoming',
        winner: completed && unique.length ? unique.join(' / ') : null,
        official: true,
        sourceUrl: STANDINGS,
      });
    });

    // Descarte so aparece no total: entra (negativo) no "bonus" da ultima etapa com resultado.
    const lastDone = Math.max(0, ...races.filter((r) => r.status === 'completed').map((r) => r.round));
    const lastBonus = results.find((r) => r.session === 'bonus' && r.raceId === races.find((x) => x.round === lastDone)?.raceId);
    for (const d of drivers) {
      if (d.discard && lastBonus) lastBonus.rows.push({ position: null, driver: d.name, status: 'descarte', points: -d.discard });
    }
    for (let i = results.length - 1; i >= 0; i--) if (results[i].session === 'bonus' && !results[i].rows.length) results.splice(i, 1);
    const standings: StandingRow[] = drivers
      .filter((d) => Number.isFinite(d.total))
      .sort((a, b) => a.position - b.position)
      .map((d) => ({ position: d.position, name: d.name, points: d.total }));
    if (results.length) notes.push('CBA nao publica ordem de chegada: vencedor deduzido pelos 25 pontos de cada prova.');

    return {
      season,
      races,
      results,
      officialStandings: standings.length ? [{ group: 'drivers', rows: standings, asOfRound: lastDone || null }] : [],
      notes,
    };
  },

  // Pontos por prova + ganhos extras - descarte, como publicados pela CBA.
  rules: {
    2026: { sessions: { race1: RACE_POINTS, race2: RACE_POINTS }, useSourcePoints: true },
  },
};
