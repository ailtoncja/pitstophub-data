import type { ManualOverride } from './overrides.ts';
import type { CategoryConfig, ChangeLog, StatusRow, Store } from './store.ts';
import type { PointsRules, RaceRecord, RaceResult, StandingsSet } from './types.ts';

// Store em memoria para testes do motor (mesmo comportamento das funcoes SQL).
export class MemoryStore implements Store {
  config = new Map<string, CategoryConfig>();
  status = new Map<string, Record<string, unknown>>();
  races: (RaceRecord & { category: string; season: number | null })[] = [];
  standings = new Map<string, { season: number | null; set: StandingsSet }>();
  results: (RaceResult & { category: string; season: number })[] = [];
  rules = new Map<string, PointsRules>();
  overrides: (ManualOverride & { category: string; season: number; active: boolean })[] = [];
  archived: unknown[] = [];
  changes: ChangeLog[] = [];

  async getConfig(category: string) {
    return this.config.get(category) ?? { mode: 'off' as const, seasonOverride: null, params: {} };
  }
  async saveParams(category: string, params: Record<string, unknown>) {
    const c = await this.getConfig(category);
    this.config.set(category, { ...c, params });
  }
  async getStatus(category: string) {
    return (this.status.get(category) as unknown as StatusRow) ?? null;
  }
  async putStatus(category: string, patch: Record<string, unknown>) {
    this.status.set(category, { consecutive_failures: 0, ...(this.status.get(category) ?? {}), ...patch });
  }
  async getRaces(category: string, season: number | null) {
    return this.races.filter((r) => r.category === category && r.season === season).sort((a, b) => a.round - b.round);
  }
  async getDriverStandings(category: string) {
    const hit = this.standings.get(`${category}:drivers`);
    return hit ? hit.set.rows.map((r) => ({ name: r.name, points: r.points, season: hit.season })) : [];
  }
  async getRules(category: string, season: number) {
    return this.rules.get(`${category}:${season}`) ?? null;
  }
  async getOverrides(category: string, season: number) {
    return this.overrides.filter((o) => o.category === category && o.season === season && o.active);
  }
  async resolveOverrides(ids: string[]) {
    for (const o of this.overrides) if (ids.includes(o.id)) o.active = false;
  }
  async applyRaces(category: string, season: number, _source: string, races: RaceRecord[]) {
    for (const race of races) {
      const i = this.races.findIndex((r) => r.category === category && r.raceId === race.raceId);
      const row = { ...race, category, season };
      if (i >= 0) this.races[i] = { ...row, winner: race.winner ?? this.races[i].winner };
      else this.races.push(row);
    }
  }
  async applyResults(category: string, season: number, _source: string, results: RaceResult[]) {
    for (const r of results) {
      this.results = this.results.filter((x) => !(x.category === category && x.raceId === r.raceId && x.session === r.session));
      this.results.push({ ...r, category, season });
    }
  }
  async applyStandings(category: string, season: number, _source: string, set: StandingsSet) {
    if (set.rows.length === 0) throw new Error('classificacao vazia');
    const key = `${category}:${set.group}`;
    const old = this.standings.get(key);
    if (old && old.season !== season) this.archived.push({ key, ...old, reason: `substituida pela temporada ${season}` });
    this.standings.set(key, { season, set: structuredClone(set) });
  }
  async archive(category: string, keepSeason: number, reason: string) {
    const moving = this.races.filter((r) => r.category === category && r.season !== keepSeason);
    this.archived.push(...moving.map((r) => ({ ...r, reason })));
    this.races = this.races.filter((r) => !(r.category === category && r.season !== keepSeason));
    // A classificacao final fica no ar ate a nova temporada ter a sua.
    return moving.length;
  }
  async logChanges(changes: ChangeLog[]) {
    this.changes.push(...changes);
  }
}
