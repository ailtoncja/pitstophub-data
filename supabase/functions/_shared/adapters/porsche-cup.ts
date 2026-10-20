// SheetJS 0.20.3 (copia do CDN oficial em _shared/vendor): corrige a falha de
// prototype pollution da 0.18.5 do npm. O deploy do Supabase nao importa do CDN.
// @deno-types="../vendor/xlsx-0.20.3/index.d.ts"
import * as XLSX from '../vendor/xlsx-0.20.3/xlsx.mjs';
import type { AdapterContext, RaceRecord, RaceResult, ResultRow, Snapshot, StandingRow, StandingsSet } from '../types.ts';
import type { AdapterWithRules } from '../engine.ts';

// Porsche Cup Brasil (porschecupbrasil.com).
//
// - Calendario: home do site, secao #etapas (cartoes com data-stage "ET 05",
//   data-date = ultimo dia, tipo Sprint/Endurance, local e categorias).
//   O numero da etapa e o oficial, mesmo fora de ordem (ET 03 foi adiada
//   para novembro e virou so Challenge/Trophy).
// - Pontuacao: planilha oficial (.xlsm) numa pasta publica do Google Drive
//   linkada na secao #resultados. Os IDs dos arquivos mudam a cada envio:
//   o adaptador acha a pasta pelo link do site, lista as subpastas e pega a
//   planilha mais nova (data no nome, ex.: PER261005 = 2026-10-05). So le
//   valores; macros nunca rodam.
//
// "drivers" = Carrera Cup do campeonato Sprint (aba CARRERA CUP), o
// campeonato principal. Outros grupos: challenge, trophy, endurance e
// endurance-challenge. Pontos = PONTUACAO (com descartes).
// Obs.: a aba DATABASE ainda lista ET3/ET8 em Goiania; o site e os
// cabecalhos das abas de pontos (ET8 = Brasilia) valem.
// Resultados: so as corridas da Carrera Sprint (race1/race2), com os pontos
// da planilha; o motor aplica o descarte (drops).
// Vencedor: Carrera C1 / C2 da etapa; endurance = dupla com mais pontos no
// segmento final; etapa sem Carrera (ET 03) usa a Challenge.

const SITE = 'https://porschecupbrasil.com/';
// Pasta conhecida em 2026, so se o site deixar de linkar a pasta.
const FALLBACK_FOLDER = '1dRhvX1ZMZjzjy0ltAfXi6N5s-pBJla5Q';
const folderUrl = (id: string) => `https://drive.google.com/embeddedfolderview?id=${id}`;
const fileUrl = (id: string) => `https://drive.usercontent.google.com/download?id=${id}&export=download`;

const SHEETS = {
  drivers: 'CARRERA CUP',
  challenge: 'CHALLENGE',
  trophy: 'SPRINT TROPHY',
  endurance: 'END. CARRERA CUP',
  'endurance-challenge': 'END. CHALLENGE',
} as const;

export interface Stage {
  stage: number;
  date: string;
  type: 'Sprint' | 'Endurance';
  venue: string;
  categories: string[];
}

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();

const textOf = (html: string, cls: string) => {
  const m = html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(?:p|h3|span|div)>`));
  return m ? decode(m[1]) : '';
};

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

/** Cartoes da secao #etapas. */
export function parseStages(html: string): Stage[] {
  const section = html.match(/<section id="etapas"[\s\S]*?<\/section>/)?.[0] ?? '';
  const out: Stage[] = [];
  for (const m of section.matchAll(/<article\b([^>]*\bp202-calendar-card\b[^>]*)>([\s\S]*?)<\/article>/g)) {
    const attrs = m[1];
    const stage = Number(attrs.match(/data-stage="ET\s*0*(\d+)"/i)?.[1]);
    const date = attrs.match(/data-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    if (!stage || !date) continue;
    const type = /endurance/i.test(textOf(m[2], 'p202-calendar-type')) ? 'Endurance' : 'Sprint';
    const cats = m[2].match(/p202-calendar-cats[\s\S]*?<\/p>/)?.[0] ?? '';
    const catText = decode(cats.replace(/^[^>]*>/, '')).replace(/^Categorias:\s*/i, '');
    out.push({
      stage,
      date,
      type,
      venue: textOf(m[2], 'p202-calendar-place'),
      categories: catText.split('/').map((c) => c.trim()).filter(Boolean),
    });
  }
  return out.sort((a, b) => a.stage - b.stage);
}

/** Entradas de uma pasta publica do Drive (pagina embeddedfolderview). */
export function parseFolder(html: string): { id: string; title: string; folder: boolean }[] {
  const out: { id: string; title: string; folder: boolean }[] = [];
  for (
    const m of html.matchAll(
      /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g,
    )
  ) {
    out.push({ id: m[1], title: decode(m[3]), folder: /\/folders\//.test(m[2]) });
  }
  return out;
}

/** "PER261005_V1_IGA_PONTUACAO.xlsm" -> "2026-10-05". */
export function fileDate(title: string): string | null {
  const m = title.match(/PER(\d{2})(\d{2})(\d{2})/i);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

async function findWorkbook(ctx: AdapterContext, html: string, season: number, notes: string[]) {
  const section = html.match(/<section id="resultados"[\s\S]*?<\/section>/)?.[0] ?? html;
  let roots = [...new Set([...section.matchAll(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/g)].map((m) => m[1]))];
  if (!roots.length) {
    notes.push('Link da pasta de resultados nao encontrado no site; usando a pasta conhecida.');
    roots = [FALLBACK_FOLDER];
  }
  const files: { id: string; title: string; date: string | null }[] = [];
  const seen = new Set<string>();
  const walk = async (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const entries = parseFolder(await ctx.http.text(folderUrl(id)));
    const sub = entries.filter((e) => e.folder);
    files.push(
      ...entries.filter((e) => !e.folder && /\.xls[xm]$/i.test(e.title)).map((e) => ({
        id: e.id,
        title: e.title,
        date: fileDate(e.title),
      })),
    );
    if (depth < 2) await Promise.all(sub.map((s) => walk(s.id, depth + 1)));
  };
  await Promise.all(roots.map((r) => walk(r, 0)));
  const dated = files.filter((f) => f.date && Number(f.date.slice(0, 4)) === season).sort((a, b) => b.date!.localeCompare(a.date!));
  return dated[0] ?? null;
}

type Cell = string | number | null;

interface Sheet {
  header: string[];
  rows: Cell[][];
  col: (name: string) => number;
}

function readSheet(wb: XLSX.WorkBook, name: string): Sheet | null {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  const aoa = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null });
  const h = aoa.findIndex((r) => norm(r[0]) === 'POSICAO');
  if (h < 0) return null;
  const header = aoa[h].map(norm);
  const rows = aoa.slice(h + 1).filter((r) => typeof r[2] === 'string' && r[2].trim());
  return { header, rows, col: (n) => header.indexOf(norm(n)) };
}

const isNum = (v: Cell): v is number => typeof v === 'number' && Number.isFinite(v);
const pts = (v: Cell) => (isNum(v) ? Math.round(v) : 0);
const hasData = (s: Sheet, c: number) => c >= 0 && s.rows.some((r) => r[c] !== null && r[c] !== '');

/** Colunas "ETn - CORRIDA k" / "ETn - SEGMENTO X" com a coluna de posicao (Ck) correspondente. */
function raceColumns(s: Sheet) {
  const posCols = s.header.map((h, i) => (/^C\d+$/.test(h) ? i : -1)).filter((i) => i >= 0);
  return s.header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => /^ET\d+\s*-\s*(CORRIDA|SEGMENTO)/.test(h))
    .map(({ h, i }, k) => ({
      stage: Number(h.match(/^ET(\d+)/)![1]),
      race: Number(h.match(/CORRIDA\s*(\d+)/)?.[1] ?? 0),
      segment: h.match(/SEGMENTO\s*(\w+)/)?.[1] ?? null,
      col: i,
      posCol: posCols[k] ?? -1,
    }));
}

/**
 * Classificacao COM descartes (coluna PONTUACAO). A coluna POSICAO da
 * planilha ordena pelo TOTAL sem descartes (o release fala em "pontuacoes com
 * e sem descartes"), entao a posicao sai da propria PONTUACAO, cujas casas
 * decimais sao o desempate da planilha (numero de vitorias, 2os...).
 */
function standings(s: Sheet): StandingRow[] {
  const net = s.col('PONTUACAO');
  if (net < 0) return [];
  const rows = s.rows
    .filter((r) => isNum(r[net]))
    .map((r) => ({ raw: r[net] as number, name: String(r[2]).trim(), points: pts(r[net]) }))
    .sort((a, b) => b.raw - a.raw || a.name.localeCompare(b.name));
  return rows.map((r) => ({
    position: 1 + rows.filter((o) => o.raw - r.raw > 1e-12).length,
    name: r.name,
    points: r.points,
  }));
}

/** Quantos piores resultados a planilha descartou (confere com rules.drops). */
function inferDrops(s: Sheet, cols: number[]): number | null {
  const d = s.col('DESCARTES');
  if (d < 0) return null;
  for (let n = 0; n <= 4; n++) {
    const ok = s.rows.every((r) => {
      const scores = cols.map((c) => pts(r[c])).sort((a, b) => a - b);
      return scores.slice(0, n).reduce((a, b) => a + b, 0) === pts(r[d]);
    });
    if (ok) return n;
  }
  return null;
}

function sprintWinners(s: Sheet | null, stage: number): string[] {
  if (!s) return [];
  return raceColumns(s)
    .filter((c) => c.stage === stage && c.race)
    .map((c) => s.rows.find((r) => r[c.posCol] === 1 && pts(r[c.col]) > 0))
    .filter((r): r is Cell[] => !!r)
    .map((r) => String(r[2]).trim());
}

function enduranceWinners(s: Sheet | null, stage: number): string[] {
  if (!s) return [];
  const c = raceColumns(s).find((x) => x.stage === stage && x.segment === 'FINAL');
  if (!c) return [];
  const best = Math.max(0, ...s.rows.map((r) => pts(r[c.col])));
  return best > 0 ? s.rows.filter((r) => pts(r[c.col]) === best).map((r) => String(r[2]).trim()) : [];
}

export const rules = {
  2026: {
    // Tabelas da aba DATABASE (referencia). Na ET7 a corrida 2 usou a tabela
    // da corrida 1; por isso o total vem dos pontos da planilha.
    sessions: {
      race1: [28, 25, 23, 21, 19, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3],
      race2: [25, 22, 20, 18, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    },
    useSourcePoints: true,
    // Carrera Sprint: 1 descarte (conferido contra a coluna DESCARTES).
    drops: 1,
  },
};

export const adapter: AdapterWithRules = {
  id: 'porsche-cup',
  source: 'porschecupbrasil.com (planilha oficial no Google Drive)',
  // A planilha costuma subir dias depois da etapa (PER261005 so apareceu em 14/10).
  staleAfterHours: 240,
  rules,

  async listSeasons(ctx) {
    const stages = parseStages(await ctx.http.text(SITE));
    return [...new Set(stages.map((s) => Number(s.date.slice(0, 4))))].sort((a, b) => a - b);
  },

  async fetchSnapshot(ctx, season): Promise<Snapshot> {
    const notes: string[] = [];
    const html = await ctx.http.text(SITE);
    const stages = parseStages(html).filter((s) => Number(s.date.slice(0, 4)) === season);
    if (!stages.length) {
      return { season, races: [], results: [], officialStandings: [], notes: ['Calendario da temporada nao encontrado no site.'] };
    }

    const today = ctx.now.toISOString().slice(0, 10);
    const sheets: Partial<Record<keyof typeof SHEETS, Sheet | null>> = {};
    if (stages.some((s) => s.date <= today)) {
      const file = await findWorkbook(ctx, html, season, notes);
      if (!file) {
        notes.push(`Nenhuma planilha de pontuacao de ${season} na pasta do Drive.`);
      } else {
        notes.push(`Planilha ${file.title} (${file.date}).`);
        const wb = XLSX.read(await ctx.http.bytes(fileUrl(file.id)), {
          type: 'array',
          sheets: Object.values(SHEETS),
          cellFormula: false,
          cellHTML: false,
          cellStyles: false,
        });
        for (const [group, name] of Object.entries(SHEETS)) sheets[group as keyof typeof SHEETS] = readSheet(wb, name);
        if (!sheets.drivers) throw new Error(`Aba ${SHEETS.drivers} nao encontrada na planilha ${file.title}.`);
      }
    }

    const carrera = sheets.drivers ?? null;
    const carreraCols = carrera ? raceColumns(carrera).filter((c) => c.race && hasData(carrera, c.col)) : [];
    const raceIdOf = new Map<number, string>();
    const races: RaceRecord[] = stages.map((st) => {
      const nn = String(st.stage).padStart(2, '0');
      const raceId = `r${nn}-${slug(st.venue)}`;
      raceIdOf.set(st.stage, raceId);
      const carreraRuns = st.categories.some((c) => /carrera/i.test(c));
      let winners: string[] = [];
      if (st.type === 'Endurance') {
        winners = enduranceWinners(carreraRuns ? sheets.endurance ?? null : null, st.stage);
        if (!winners.length) winners = enduranceWinners(sheets['endurance-challenge'] ?? null, st.stage);
      } else {
        winners = sprintWinners(carreraRuns ? carrera : null, st.stage);
        if (!winners.length) winners = sprintWinners(sheets.challenge ?? null, st.stage);
        if (!winners.length) winners = sprintWinners(sheets.trophy ?? null, st.stage);
      }
      const done = winners.length > 0;
      return {
        raceId,
        round: st.stage,
        name: st.type === 'Endurance' ? `${st.venue} (Endurance)` : st.venue,
        enName: `Etapa ${nn} - ${st.type} - ${st.venue}`,
        location: st.venue,
        date: st.date,
        startsAt: null,
        status: done ? 'completed' : 'upcoming',
        // Sprint: vencedores das duas corridas; endurance: a dupla.
        winner: done ? [...new Set(winners)].join(' / ') : null,
        official: done ? true : undefined,
        externalId: `ET ${nn}`,
        sourceUrl: `${SITE}#etapas`,
      };
    });

    // Resultados da Carrera Sprint: todo piloto da aba em toda corrida
    // disputada (0 quando nao pontuou), para o descarte bater com a planilha.
    const results: RaceResult[] = [];
    if (carrera) {
      const numCol = carrera.col('NUMERO');
      for (const c of carreraCols) {
        const raceId = raceIdOf.get(c.stage);
        if (!raceId) {
          notes.push(`ET${c.stage} esta na planilha mas nao no calendario do site.`);
          continue;
        }
        const placeholder = Math.max(0, ...carrera.rows.map((r) => (isNum(r[c.posCol]) ? r[c.posCol] as number : 0)));
        const rows: ResultRow[] = carrera.rows.map((r) => {
          const raw = r[c.col];
          const p = pts(raw);
          const pos = isNum(r[c.posCol]) ? r[c.posCol] as number : null;
          const status = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : null;
          return {
            // Posicao "de sobra" (21/20) com 0 ponto = nao pontuou/nao correu.
            position: pos && !status && (p > 0 || pos < placeholder) ? pos : null,
            driver: String(r[2]).trim(),
            number: numCol >= 0 && r[numCol] != null ? String(r[numCol]) : null,
            status,
            points: p,
          };
        });
        rows.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
        results.push({ raceId, session: `race${c.race}`, official: true, rows });
      }
      const drops = inferDrops(carrera, carreraCols.map((c) => c.col));
      if (drops !== null && drops !== rules[2026].drops) {
        notes.push(`Planilha descartou ${drops} resultado(s) por piloto; a regra diz ${rules[2026].drops}. Confira o regulamento.`);
      }
      if (drops === null) notes.push('Coluna DESCARTES nao corresponde a um numero fixo de piores resultados.');
    }

    const officialStandings: StandingsSet[] = [];
    for (const group of Object.keys(SHEETS) as (keyof typeof SHEETS)[]) {
      const s = sheets[group];
      if (!s) continue;
      const rows = standings(s);
      if (!rows.length) continue;
      const cols = raceColumns(s).filter((c) => hasData(s, c.col));
      officialStandings.push({ group, rows, asOfRound: cols.length ? Math.max(...cols.map((c) => c.stage)) : null });
    }

    return { season, races, results, officialStandings, notes };
  },
};
