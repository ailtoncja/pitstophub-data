import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import type { ManualOverride } from './overrides.ts';
import type { PointsRules, RaceRecord, RaceResult, StandingsSet, SyncMode } from './types.ts';

// Acesso ao banco atras de uma interface, para o motor ser testado sem Supabase.

export interface CategoryConfig {
  mode: SyncMode;
  seasonOverride: number | null;
  params: Record<string, unknown>;
}

export interface StatusRow {
  season: number | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_alert_key: string | null;
  last_alert_at: string | null;
}

export interface ChangeLog {
  runId: string;
  category: string;
  season: number | null;
  entity: string;
  key: string;
  before: unknown;
  after: unknown;
  source: string;
}

export interface Store {
  getConfig(category: string): Promise<CategoryConfig>;
  saveParams(category: string, params: Record<string, unknown>): Promise<void>;
  getStatus(category: string): Promise<StatusRow | null>;
  putStatus(category: string, patch: Record<string, unknown>): Promise<void>;
  getRaces(category: string, season: number | null): Promise<RaceRecord[]>;
  getDriverStandings(category: string): Promise<{ name: string; points: number; season: number | null }[]>;
  getRules(category: string, season: number): Promise<PointsRules | null>;
  getOverrides(category: string, season: number): Promise<ManualOverride[]>;
  resolveOverrides(ids: string[]): Promise<void>;
  applyRaces(category: string, season: number, source: string, races: RaceRecord[]): Promise<void>;
  applyResults(category: string, season: number, source: string, results: RaceResult[]): Promise<void>;
  applyStandings(category: string, season: number, source: string, set: StandingsSet): Promise<void>;
  archive(category: string, keepSeason: number, reason: string): Promise<number>;
  logChanges(changes: ChangeLog[]): Promise<void>;
}

function toRace(row: Record<string, unknown>): RaceRecord {
  return {
    raceId: String(row.race_id),
    round: Number(row.round ?? 0),
    name: String(row.name),
    enName: (row.en_name as string) ?? null,
    location: (row.location as string) ?? null,
    enLocation: (row.en_location as string) ?? null,
    circuit: (row.circuit as string) ?? null,
    date: String(row.date),
    startsAt: (row.starts_at as string) ?? null,
    status: row.status as RaceRecord['status'],
    winner: (row.winner as string) ?? null,
    official: row.official == null ? true : Boolean(row.official),
    externalId: (row.external_id as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
  };
}

export class SupabaseStore implements Store {
  constructor(private db: SupabaseClient) {}

  static fromEnv(): SupabaseStore {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  private check<T>({ data, error }: { data: T; error: { message: string } | null }): T {
    if (error) throw new Error(error.message);
    return data;
  }

  async getConfig(category: string): Promise<CategoryConfig> {
    const data = this.check(
      await this.db.from('category_config').select('mode, season_override, params').eq('category_id', category).maybeSingle(),
    );
    return {
      mode: (data?.mode ?? 'off') as SyncMode,
      seasonOverride: data?.season_override ?? null,
      params: (data?.params as Record<string, unknown>) ?? {},
    };
  }

  async saveParams(category: string, params: Record<string, unknown>) {
    this.check(await this.db.from('category_config').update({ params, updated_at: new Date().toISOString() }).eq('category_id', category));
  }

  async getStatus(category: string): Promise<StatusRow | null> {
    return this.check(
      await this.db
        .from('sync_status')
        .select('season, last_success_at, consecutive_failures, last_alert_key, last_alert_at')
        .eq('category_id', category)
        .maybeSingle(),
    ) as StatusRow | null;
  }

  async putStatus(category: string, patch: Record<string, unknown>) {
    this.check(await this.db.from('sync_status').upsert({ category_id: category, ...patch }));
  }

  async getRaces(category: string, season: number | null): Promise<RaceRecord[]> {
    let query = this.db.from('synced_races').select('*').eq('category_id', category);
    query = season == null ? query.is('season', null) : query.eq('season', season);
    const data = this.check(await query.order('round'));
    return (data ?? []).map(toRace);
  }

  async getDriverStandings(category: string) {
    const data = this.check(
      await this.db.from('synced_standings').select('name, points, season').eq('category_id', category).order('position'),
    );
    return (data ?? []).map((r) => ({ name: r.name as string, points: Number(r.points), season: (r.season as number) ?? null }));
  }

  async getRules(category: string, season: number): Promise<PointsRules | null> {
    const data = this.check(
      await this.db.from('points_rules').select('rules').eq('category_id', category).eq('season', season).maybeSingle(),
    );
    return (data?.rules as PointsRules) ?? null;
  }

  async getOverrides(category: string, season: number): Promise<ManualOverride[]> {
    const data = this.check(
      await this.db
        .from('manual_overrides')
        .select('id, race_id, kind, value')
        .eq('category_id', category)
        .eq('season', season)
        .eq('active', true),
    );
    return (data ?? []) as ManualOverride[];
  }

  async resolveOverrides(ids: string[]) {
    if (ids.length === 0) return;
    this.check(
      await this.db.from('manual_overrides').update({ active: false, resolved_at: new Date().toISOString() }).in('id', ids),
    );
  }

  async applyRaces(category: string, season: number, source: string, races: RaceRecord[]) {
    this.check(await this.db.rpc('sync_apply_races', { p_category: category, p_season: season, p_source: source, p_rows: races }));
  }

  async applyResults(category: string, season: number, source: string, results: RaceResult[]) {
    if (results.length === 0) return;
    const rows = results.map((r) => ({
      category_id: category,
      season,
      race_id: r.raceId,
      session: r.session,
      official: r.official,
      rows: r.rows,
      source,
      updated_at: new Date().toISOString(),
    }));
    this.check(await this.db.from('race_results').upsert(rows));
  }

  async applyStandings(category: string, season: number, source: string, set: StandingsSet) {
    this.check(
      await this.db.rpc('sync_apply_standings', {
        p_category: category,
        p_season: season,
        p_group: set.group,
        p_source: source,
        p_as_of_round: set.asOfRound ?? null,
        p_rows: set.rows,
      }),
    );
  }

  async archive(category: string, keepSeason: number, reason: string): Promise<number> {
    return Number(
      this.check(await this.db.rpc('sync_archive_category', { p_category: category, p_keep_season: keepSeason, p_reason: reason })) ?? 0,
    );
  }

  async logChanges(changes: ChangeLog[]) {
    if (changes.length === 0) return;
    this.check(
      await this.db.from('sync_changes').insert(
        changes.map((c) => ({
          run_id: c.runId,
          category_id: c.category,
          season: c.season,
          entity: c.entity,
          entity_key: c.key,
          before: c.before ?? null,
          after: c.after ?? null,
          source: c.source,
        })),
      ),
    );
  }
}
