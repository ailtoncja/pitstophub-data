import type { RaceRecord, Snapshot, StandingsSet } from './types.ts';

// Travas antes de gravar. "problems" bloqueiam a gravacao daquela parte e
// geram alerta; "warnings" so vao para o relatorio.

export interface ValidationResult {
  problems: string[];
  warnings: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PreviousState {
  races: RaceRecord[];
  /** Classificacao "drivers" gravada da mesma temporada. */
  standings: { name: string; points: number }[];
}

export function validateRaces(snapshot: Snapshot, previous: PreviousState): ValidationResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { races, season } = snapshot;

  if (races.length === 0) {
    problems.push('A fonte devolveu um calendario vazio.');
    return { problems, warnings };
  }

  const ids = new Set<string>();
  for (const race of races) {
    if (!race.raceId) problems.push(`Corrida sem identificador (rodada ${race.round}).`);
    if (ids.has(race.raceId)) problems.push(`Corrida repetida: ${race.raceId}.`);
    ids.add(race.raceId);
    if (!DATE_RE.test(race.date)) problems.push(`Data invalida em ${race.raceId}: "${race.date}".`);
    else if (Number(race.date.slice(0, 4)) !== season && Number(race.date.slice(0, 4)) !== season + 1) {
      // Temporadas que cruzam o ano (ex.: WEC antigo) aceitam o ano seguinte.
      problems.push(`${race.raceId} tem data ${race.date}, fora da temporada ${season}.`);
    }
    if (!Number.isInteger(race.round) || race.round < 1 || race.round > 60) {
      problems.push(`Rodada invalida em ${race.raceId}: ${race.round}.`);
    }
    if (race.status === 'completed' && !race.winner) {
      warnings.push(`${race.name || race.raceId} terminou mas ainda esta sem vencedor na fonte.`);
    }
  }

  // Uma resposta "encolhida" costuma ser a fonte degradada, nao o calendario
  // mudando de verdade. Mantem o que temos e avisa.
  const prevSameSeason = previous.races.length;
  if (prevSameSeason >= 4 && races.length < Math.ceil(prevSameSeason * 0.7)) {
    problems.push(`A fonte trouxe ${races.length} corridas, contra ${prevSameSeason} ja salvas. Parece incompleta.`);
  }

  // Corrida que ja tinha vencedor nao pode "perder" o vencedor.
  const prevById = new Map(previous.races.map((r) => [r.raceId, r]));
  for (const race of races) {
    const before = prevById.get(race.raceId);
    if (before?.winner && !race.winner && before.status === 'completed') {
      warnings.push(`${race.raceId} tinha vencedor (${before.winner}) e a fonte agora veio sem. Mantendo o anterior.`);
      race.winner = before.winner;
    }
  }

  return { problems, warnings };
}

export function validateStandings(set: StandingsSet, previous: PreviousState['standings']): ValidationResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const rows = set.rows;
  if (rows.length === 0) {
    problems.push(`Classificacao "${set.group}" vazia.`);
    return { problems, warnings };
  }
  rows.forEach((row, i) => {
    if (!row.name?.trim()) problems.push(`Linha ${i + 1} da classificacao sem nome.`);
    if (!Number.isFinite(row.points)) problems.push(`Pontos invalidos para ${row.name}.`);
    if (row.position < 1 || row.position > rows.length) problems.push(`Posicao invalida para ${row.name}: ${row.position}.`);
    if (i > 0 && row.points > rows[i - 1].points + 1e-9) {
      problems.push(`Classificacao fora de ordem: ${row.name} (${row.points}) acima de ${rows[i - 1].name} (${rows[i - 1].points}).`);
    }
  });

  if (set.group === 'drivers' && previous.length > 0) {
    const prevTotal = previous.reduce((s, r) => s + r.points, 0);
    const total = rows.reduce((s, r) => s + r.points, 0);
    if (total + 1e-9 < prevTotal * 0.9) {
      problems.push(`A soma de pontos caiu de ${prevTotal} para ${total}. Parece classificacao antiga ou incompleta.`);
    }
    const prevByName = new Map(previous.map((r) => [r.name, r.points]));
    for (const row of rows) {
      const before = prevByName.get(row.name);
      if (before != null && row.points + 1e-9 < before) {
        warnings.push(`${row.name} perdeu pontos (${before} -> ${row.points}). Pode ser punicao; confira.`);
      }
    }
  }
  return { problems, warnings };
}
