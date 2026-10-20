import type { RaceRecord } from './types.ts';

// Decide qual temporada acompanhar. Nada de ano fixo no codigo: o adaptador
// diz quais temporadas a fonte ja publicou, e aqui aplicamos a regra de virada.

export interface SeasonDecision {
  season: number;
  rollover: boolean;
  reason: string;
}

/** Temporada encerrada = nenhuma corrida pendente e a ultima ja passou ha 3 dias. */
export function isSeasonFinished(races: RaceRecord[], now: Date): boolean {
  if (races.length === 0) return false;
  if (races.some((r) => r.status === 'upcoming')) return false;
  const last = races.reduce((max, r) => (r.date > max ? r.date : max), races[0].date);
  return now.getTime() - new Date(`${last}T23:59:59Z`).getTime() > 3 * 24 * 3600 * 1000;
}

export function decideSeason(opts: {
  available: number[];
  current: number | null;
  currentRaces: RaceRecord[];
  override: number | null;
  now: Date;
}): SeasonDecision {
  const { available, current, currentRaces, override, now } = opts;
  if (override) return { season: override, rollover: override !== current, reason: 'temporada fixada no painel' };

  const sorted = [...new Set(available)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    if (current) return { season: current, rollover: false, reason: 'fonte nao listou temporadas; mantendo a atual' };
    throw new Error('A fonte nao listou nenhuma temporada.');
  }

  // Primeira execucao: a temporada mais recente que ja comecou (ou a ultima publicada).
  if (!current) {
    const year = now.getUTCFullYear();
    const started = sorted.filter((y) => y <= year);
    const season = started.length ? started[started.length - 1] : sorted[0];
    return { season, rollover: false, reason: 'primeira execucao' };
  }

  const newer = sorted.filter((y) => y > current);
  if (newer.length === 0) return { season: current, rollover: false, reason: 'sem temporada nova publicada' };

  // So vira quando a atual acabou: assim o resultado final de 2026 ainda entra
  // mesmo que o calendario de 2027 ja tenha saido.
  if (isSeasonFinished(currentRaces, now)) {
    return { season: newer[0], rollover: true, reason: `temporada ${current} encerrada e ${newer[0]} publicada` };
  }
  return { season: current, rollover: false, reason: `${newer[0]} ja publicada, mas ${current} ainda nao terminou` };
}
