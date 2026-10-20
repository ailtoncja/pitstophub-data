import type { Snapshot } from './types.ts';

// Correcoes feitas no painel. Aplicadas por cima do que veio da fonte; quando
// a fonte passa a trazer o mesmo valor, a correcao e marcada como resolvida.

export interface ManualOverride {
  id: string;
  race_id: string | null;
  kind: 'winner' | 'race_status' | 'race_date' | 'standing_points';
  value: unknown;
}

export interface OverrideOutcome {
  applied: string[];
  resolved: string[];
}

export function applyOverrides(snapshot: Snapshot, overrides: ManualOverride[]): OverrideOutcome {
  const applied: string[] = [];
  const resolved: string[] = [];
  const races = new Map(snapshot.races.map((r) => [r.raceId, r]));

  for (const o of overrides) {
    if (o.kind === 'standing_points') {
      const { name, points } = o.value as { name: string; points: number };
      const set = snapshot.officialStandings.find((s) => s.group === 'drivers');
      const row = set?.rows.find((r) => r.name === name);
      if (row && row.points === points) resolved.push(o.id);
      else if (row) {
        row.points = points;
        set!.rows.sort((a, b) => b.points - a.points).forEach((r, i) => (r.position = i + 1));
        applied.push(o.id);
      }
      continue;
    }

    const race = o.race_id ? races.get(o.race_id) : undefined;
    if (!race) continue;
    if (o.kind === 'winner') {
      const winner = String(o.value);
      if (race.winner === winner) resolved.push(o.id);
      else {
        race.winner = winner;
        race.status = 'completed';
        applied.push(o.id);
      }
    } else if (o.kind === 'race_status') {
      const status = o.value as typeof race.status;
      if (race.status === status) resolved.push(o.id);
      else {
        race.status = status;
        applied.push(o.id);
      }
    } else if (o.kind === 'race_date') {
      const date = String(o.value);
      if (race.date === date) resolved.push(o.id);
      else {
        race.date = date;
        applied.push(o.id);
      }
    }
  }
  return { applied, resolved };
}
