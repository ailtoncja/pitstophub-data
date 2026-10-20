import type { PointsRules, RaceRecord, RaceResult, StandingRow, StandingsSet } from './types.ts';

// Calcula a classificacao a partir dos resultados de cada corrida. Assim a
// tabela de pontos nunca fica "parada numa etapa" so porque a fonte nao
// publicou a classificacao, e da para conferir a oficial (e vice-versa).

function multiplierFor(rules: PointsRules, raceId: string): number {
  for (const [key, factor] of Object.entries(rules.multipliers ?? {})) {
    if (key.startsWith('/') && key.endsWith('/')) {
      if (new RegExp(key.slice(1, -1), 'i').test(raceId)) return factor;
    } else if (key === raceId) {
      return factor;
    }
  }
  return 1;
}

function pointsForRow(rules: PointsRules, result: RaceResult, position: number | null, sourcePoints?: number | null) {
  if (rules.useSourcePoints) return sourcePoints ?? 0;
  if (position == null) return 0;
  const table = rules.sessions[result.session] ?? rules.sessions.race ?? [];
  return table[position - 1] ?? 0;
}

/**
 * Posicao dentro da classe, quando a fonte so traz a posicao geral.
 * Linhas com a mesma posicao geral na mesma classe sao o mesmo carro (uma
 * linha por piloto da tripulacao) e dividem a posicao na classe.
 */
function classPositions(result: RaceResult): Map<number, number | null> {
  const byClass = new Map<string, { count: number; lastOverall: number }>();
  const out = new Map<number, number | null>();
  const ordered = result.rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.position ?? Infinity) - (b.row.position ?? Infinity));
  for (const { row, index } of ordered) {
    if (row.position == null) {
      out.set(index, null);
      continue;
    }
    const key = row.class ?? '';
    const state = byClass.get(key) ?? { count: 0, lastOverall: NaN };
    if (state.lastOverall !== row.position) {
      state.count++;
      state.lastOverall = row.position;
    }
    byClass.set(key, state);
    out.set(index, state.count);
  }
  return out;
}

export function computeStandings(
  rules: PointsRules,
  races: RaceRecord[],
  results: RaceResult[],
): StandingsSet[] {
  // Conta toda sessao que ja tem resultado, mesmo com o fim de semana em
  // andamento (ex.: sprint de sabado antes da feature de domingo): a
  // classificacao oficial ja soma esses pontos, entao a conferencia bate.
  const byId = new Map(races.filter((r) => r.status !== 'cancelled').map((r) => [r.raceId, r]));
  // grupo -> piloto -> lista de pontos por sessao
  const tally = new Map<string, Map<string, { team: string | null; scores: number[] }>>();
  let asOfRound = 0;

  for (const result of results) {
    const race = byId.get(result.raceId);
    if (!race || result.rows.length === 0) continue;
    if (race.status === 'completed') asOfRound = Math.max(asOfRound, race.round);
    const factor = multiplierFor(rules, result.raceId);
    const positions = rules.perClass ? classPositions(result) : null;

    result.rows.forEach((row, index) => {
      const position = positions ? positions.get(index) ?? null : row.position;
      const points = pointsForRow(rules, result, position, row.points) * (rules.useSourcePoints ? 1 : factor);
      const group = rules.perClass && row.class ? rules.classGroupNames?.[row.class] ?? `class:${row.class}` : 'drivers';
      if (!tally.has(group)) tally.set(group, new Map());
      const drivers = tally.get(group)!;
      const entry = drivers.get(row.driver) ?? { team: row.team ?? null, scores: [] };
      entry.scores.push(points);
      if (row.team) entry.team = row.team;
      drivers.set(row.driver, entry);
    });
  }

  const sets: StandingsSet[] = [];
  for (const [group, drivers] of tally) {
    const rows = [...drivers.entries()].map(([name, { team, scores }]) => {
      const kept = rules.drops ? [...scores].sort((a, b) => b - a).slice(0, Math.max(0, scores.length - rules.drops)) : scores;
      return { name, team, points: round2(kept.reduce((s, p) => s + p, 0)) };
    });
    rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    const scored = rows.filter((r) => r.points > 0).map((r, i): StandingRow => ({ position: i + 1, ...r }));
    if (scored.length) sets.push({ group, asOfRound: asOfRound || null, rows: scored });
  }
  return sets;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export interface StandingsComparison {
  matches: boolean;
  differences: string[];
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Compara a classificacao calculada com a oficial. Diferencas viram alerta
 * ("a regra de pontos mudou?" / "faltou um resultado?"), nunca dado publicado.
 */
export function compareStandings(computed: StandingRow[], official: StandingRow[], tolerance = 0.5): StandingsComparison {
  const differences: string[] = [];
  const officialByName = new Map(official.map((r) => [norm(r.name), r]));
  for (const row of computed.slice(0, 10)) {
    const match = officialByName.get(norm(row.name));
    if (!match) {
      differences.push(`${row.name} (${row.points}) nao aparece na classificacao oficial`);
    } else if (Math.abs(match.points - row.points) > tolerance) {
      differences.push(`${row.name}: calculado ${row.points}, oficial ${match.points}`);
    }
  }
  return { matches: differences.length === 0, differences };
}
