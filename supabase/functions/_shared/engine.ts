import { sendAlert, shouldResend } from './alert.ts';
import { applyOverrides } from './overrides.ts';
import { compareStandings, computeStandings } from './points.ts';
import { decideSeason } from './season.ts';
import type { Store } from './store.ts';
import type { Adapter, Change, HttpClient, PointsRules, RaceRecord, RunReport, StandingsSet } from './types.ts';
import { validateRaces, validateStandings } from './validate.ts';

export interface EngineOptions {
  http: HttpClient;
  now?: Date;
  runId?: string;
  /** Forca modo teste nesta execucao, mesmo com a categoria em "live". */
  forceDryRun?: boolean;
  alert?: (text: string) => Promise<boolean>;
}

/** Regra padrao do adaptador para a temporada (ou a mais recente conhecida). */
export function pickDefaultRules(adapter: AdapterWithRules, season: number): { rules: PointsRules | null; assumed: boolean } {
  const table = adapter.rules ?? {};
  if (table[season]) return { rules: table[season], assumed: false };
  const known = Object.keys(table).map(Number).filter((y) => y < season).sort((a, b) => b - a);
  return known.length ? { rules: table[known[0]], assumed: true } : { rules: null, assumed: false };
}

export type AdapterWithRules = Adapter & { rules?: Record<number, PointsRules> };

const RACE_FIELDS: (keyof RaceRecord)[] = ['round', 'name', 'date', 'startsAt', 'status', 'winner', 'circuit', 'location', 'official'];

function diffRaces(before: RaceRecord[], after: RaceRecord[]): Change[] {
  const prev = new Map(before.map((r) => [r.raceId, r]));
  const changes: Change[] = [];
  for (const race of after) {
    const old = prev.get(race.raceId);
    if (!old) {
      changes.push({ entity: 'race', key: race.raceId, before: null, after: race });
      continue;
    }
    const changed = RACE_FIELDS.filter((f) => (old[f] ?? null) !== (race[f] ?? null) && !(f === 'startsAt' && sameInstant(old.startsAt, race.startsAt)));
    if (changed.length) {
      changes.push({
        entity: 'race',
        key: race.raceId,
        before: Object.fromEntries(changed.map((f) => [f, old[f] ?? null])),
        after: Object.fromEntries(changed.map((f) => [f, race[f] ?? null])),
      });
    }
  }
  return changes;
}

function sameInstant(a?: string | null, b?: string | null) {
  if (!a || !b) return a == b;
  return new Date(a).getTime() === new Date(b).getTime();
}

function staleRaces(races: RaceRecord[], now: Date, hours: number): RaceRecord[] {
  return races.filter((r) => {
    if (r.status === 'cancelled' || r.winner) return false;
    const end = new Date(`${r.date}T23:59:59Z`).getTime();
    return now.getTime() - end > hours * 3600 * 1000 && now.getTime() - end < 45 * 24 * 3600 * 1000;
  });
}

export async function runCategory(adapter: AdapterWithRules, store: Store, opts: EngineOptions): Promise<RunReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const runId = opts.runId ?? crypto.randomUUID();
  const alert = opts.alert ?? sendAlert;
  const category = adapter.id;
  const config = await store.getConfig(category);
  const mode = opts.forceDryRun && config.mode === 'live' ? 'dry_run' : config.mode;

  const report: RunReport = {
    category, mode, season: null, ok: false, wrote: false,
    changes: [], problems: [], warnings: [], asOfRound: null, durationMs: 0,
  };
  if (mode === 'off') {
    report.ok = true;
    report.warnings.push('Categoria desligada no painel.');
    return report;
  }

  const status = await store.getStatus(category);
  const ctx = { http: opts.http, now, params: { ...config.params } };
  let alertText: string | null = null;
  let alertKey: string | null = null;
  let phase = `ler a fonte (${adapter.source})`;

  try {
    const available = await adapter.listSeasons(ctx);
    const currentSeason = status?.season ?? null;
    const currentRaces = currentSeason ? await store.getRaces(category, currentSeason) : [];
    const decision = decideSeason({ available, current: currentSeason, currentRaces, override: config.seasonOverride, now });
    const season = decision.season;
    report.season = season;
    if (decision.rollover) report.warnings.push(`Virada de temporada: ${decision.reason}.`);
    // Ensaio da virada: a partir de outubro, avisa no relatorio se a fonte
    // ainda nao publicou a proxima temporada.
    if (now.getUTCMonth() >= 9 && !available.includes(season + 1)) {
      report.warnings.push(`Temporada ${season + 1} ainda nao publicada na fonte.`);
    }

    const snapshot = await adapter.fetchSnapshot(ctx, season);
    if (snapshot.season !== season) throw new Error(`Adaptador devolveu temporada ${snapshot.season}, pedida ${season}.`);
    report.warnings.push(...(snapshot.notes ?? []));

    const previousRaces = decision.rollover ? [] : await store.getRaces(category, season);
    const previousStandingsAll = await store.getDriverStandings(category);
    const previousStandings = previousStandingsAll.filter((r) => r.season === season);

    // Correcoes do painel por cima da fonte.
    const overrides = await store.getOverrides(category, season);
    const overrideOutcome = applyOverrides(snapshot, overrides);
    if (overrideOutcome.applied.length) report.warnings.push(`${overrideOutcome.applied.length} correcao(oes) manual(is) aplicada(s).`);

    // 1) Calendario e resultados.
    const raceCheck = validateRaces(snapshot, { races: previousRaces, standings: previousStandings });
    report.problems.push(...raceCheck.problems);
    report.warnings.push(...raceCheck.warnings);
    const racesOk = raceCheck.problems.length === 0;

    // 2) Classificacao: calculada a partir dos resultados x oficial.
    const dbRules = await store.getRules(category, season);
    const fallback = pickDefaultRules(adapter, season);
    const rules = dbRules ?? fallback.rules;
    if (!dbRules && fallback.assumed) {
      report.warnings.push(`Sem regra de pontos para ${season}; usando a da temporada anterior ate confirmar.`);
    }
    const computed = rules && snapshot.results.length ? computeStandings(rules, snapshot.races, snapshot.results) : [];
    const official = snapshot.officialStandings;
    const toPublish: StandingsSet[] = [];
    const groups = new Set([...official.map((s) => s.group), ...computed.map((s) => s.group)]);

    for (const group of groups) {
      const off = official.find((s) => s.group === group);
      const calc = computed.find((s) => s.group === group);
      if (off && calc && off.rows.length && calc.rows.length) {
        const cmp = compareStandings(calc.rows, off.rows);
        if (cmp.matches) {
          toPublish.push(off);
        } else if (previousStandings.length === 0 && group === 'drivers') {
          // Sem nada salvo ainda: publica a oficial, mas avisa.
          toPublish.push(off);
          report.warnings.push(`Classificacao calculada difere da oficial (${group}): ${cmp.differences.slice(0, 3).join('; ')}.`);
        } else {
          report.problems.push(
            `Classificacao calculada nao bate com a oficial (${group}): ${cmp.differences.slice(0, 3).join('; ')}. ` +
              'Mantida a versao anterior. A regra de pontos mudou ou falta algum resultado?',
          );
        }
      } else if (off?.rows.length) {
        toPublish.push(off);
      } else if (calc?.rows.length) {
        toPublish.push(calc);
      }
    }

    const standingsOk: StandingsSet[] = [];
    for (const set of toPublish) {
      const check = validateStandings(set, set.group === 'drivers' ? previousStandings : []);
      report.warnings.push(...check.warnings);
      if (check.problems.length) report.problems.push(...check.problems.map((p) => `[${set.group}] ${p}`));
      else standingsOk.push(set);
    }
    const drivers = standingsOk.find((s) => s.group === 'drivers');
    report.asOfRound = drivers?.asOfRound ?? Math.max(0, ...snapshot.races.filter((r) => r.status === 'completed').map((r) => r.round));

    // 3) Diferencas (vao para o relatorio e, se gravar, para o historico).
    if (racesOk) report.changes.push(...diffRaces(previousRaces, snapshot.races));
    if (drivers) {
      const before = previousStandings.map((r) => `${r.name}:${r.points}`).join('|');
      const after = drivers.rows.map((r) => `${r.name}:${r.points}`).join('|');
      if (before !== after) {
        report.changes.push({
          entity: 'standings',
          key: 'drivers',
          before: previousStandings.slice(0, 10),
          after: drivers.rows.slice(0, 10),
        });
      }
    }

    // 4) Atraso: corrida que ja passou e continua sem resultado.
    const late = staleRaces(snapshot.races, now, adapter.staleAfterHours ?? 24);
    if (late.length) {
      report.warnings.push(`Sem resultado ainda: ${late.map((r) => `${r.name} (${r.date})`).join(', ')}.`);
      alertKey = `stale:${late.map((r) => r.raceId).join(',')}`;
      alertText = `⏱️ ${category}: corrida sem resultado depois de ${adapter.staleAfterHours ?? 24} h: ${late.map((r) => `${r.name} (${r.date})`).join(', ')}.`;
    }

    // 5) Gravacao.
    if (mode === 'live') {
      phase = 'gravar no banco';
      if (racesOk) {
        // Corridas de outra temporada ou do sistema antigo (season null) vao
        // para o arquivo. A classificacao antiga fica ate a nova existir.
        const legacy = (await store.getRaces(category, null)).length > 0;
        if (decision.rollover || legacy) {
          const moved = await store.archive(category, season, decision.rollover ? `virada para ${season}` : 'substituido pelo motor novo');
          if (moved > 0) report.warnings.push(`${moved} corrida(s) antiga(s) movida(s) para o arquivo.`);
        }
        await store.applyRaces(category, season, adapter.source, snapshot.races);
        await store.applyResults(category, season, adapter.source, snapshot.results);
        for (const set of standingsOk) await store.applyStandings(category, season, adapter.source, set);
        await store.logChanges(
          report.changes.map((c) => ({ runId, category, season, entity: c.entity, key: c.key, before: c.before, after: c.after, source: adapter.source })),
        );
        if (decision.rollover) {
          await store.logChanges([{ runId, category, season, entity: 'season', key: String(season), before: currentSeason, after: season, source: adapter.source }]);
        }
        await store.resolveOverrides(overrideOutcome.resolved);
        report.wrote = true;
      }
      if (JSON.stringify(ctx.params) !== JSON.stringify(config.params)) await store.saveParams(category, ctx.params);
    }

    report.ok = report.problems.length === 0;
    if (!report.ok) {
      alertKey = `problems:${report.problems.join('|')}`;
      alertText = `⚠️ ${category} (${season}): nada foi publicado nesta parte.\n- ${report.problems.slice(0, 5).join('\n- ')}`;
    } else if (decision.rollover && mode === 'live') {
      alertKey = `rollover:${season}`;
      alertText = `🏁 ${category}: virou para a temporada ${season} (${decision.reason}). ${season - 1} foi para o arquivo.`;
    }

    report.durationMs = Date.now() - started;
    await store.putStatus(category, {
      season: mode === 'live' && racesOk ? season : status?.season ?? null,
      mode,
      source: adapter.source,
      last_run_at: now.toISOString(),
      ...(report.ok ? { last_success_at: now.toISOString(), consecutive_failures: 0, last_error: null } : {}),
      ...(report.wrote && report.changes.length ? { last_change_at: now.toISOString() } : {}),
      as_of_round: report.asOfRound,
      problems: report.problems,
      warnings: report.warnings,
      last_report: report,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.problems.push(`Falha ao ${phase}: ${message}`);
    report.durationMs = Date.now() - started;
    const failures = (status?.consecutive_failures ?? 0) + 1;
    await store.putStatus(category, {
      mode,
      source: adapter.source,
      last_run_at: now.toISOString(),
      consecutive_failures: failures,
      last_error: message,
      problems: report.problems,
      last_report: report,
    });
    // Uma falha isolada costuma ser instabilidade; avisa a partir da segunda seguida.
    if (failures >= 2) {
      alertKey = `fail:${message}`;
      alertText = `❌ ${category}: a fonte ${adapter.source} falhou ${failures} vezes seguidas.\n${message}`;
    }
  }

  if (alertText && alertKey && mode === 'live') {
    const fresh = await store.getStatus(category);
    if (shouldResend(fresh?.last_alert_key ?? null, fresh?.last_alert_at ?? null, alertKey, now)) {
      await alert(alertText);
      await store.putStatus(category, { last_alert_key: alertKey, last_alert_at: now.toISOString() });
    }
  }
  return report;
}
