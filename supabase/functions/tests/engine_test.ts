import { assert, assertEquals } from 'jsr:@std/assert@1';
import { runCategory, type AdapterWithRules } from '../_shared/engine.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { MemoryStore } from '../_shared/memory-store.ts';
import { computeStandings } from '../_shared/points.ts';
import { decideSeason } from '../_shared/season.ts';
import type { RaceRecord, Snapshot } from '../_shared/types.ts';

const http = fixtureHttp({});
const quiet = async () => true;

function race(round: number, date: string, status: RaceRecord['status'], winner: string | null = null): RaceRecord {
  return { raceId: `r${round}`, round, name: `Rodada ${round}`, date, status, winner };
}

function fakeAdapter(seasons: number[], snapshots: Record<number, Snapshot>): AdapterWithRules {
  return {
    id: 'test',
    source: 'fake',
    listSeasons: async () => seasons,
    fetchSnapshot: async (_ctx, season) => structuredClone(snapshots[season]),
    rules: { 2026: { sessions: { race: [10, 6, 4] } } },
  };
}

const snap2026: Snapshot = {
  season: 2026,
  races: [race(1, '2026-03-01', 'completed', 'Ana'), race(2, '2026-04-01', 'completed', 'Bia'), race(3, '2026-05-01', 'upcoming')],
  results: [
    { raceId: 'r1', session: 'race', official: true, rows: [{ position: 1, driver: 'Ana' }, { position: 2, driver: 'Bia' }] },
    { raceId: 'r2', session: 'race', official: true, rows: [{ position: 1, driver: 'Bia' }, { position: 2, driver: 'Ana' }] },
  ],
  officialStandings: [],
};

Deno.test('dry run nao grava nada mas gera relatorio', async () => {
  const store = new MemoryStore();
  store.config.set('test', { mode: 'dry_run', seasonOverride: null, params: {} });
  const report = await runCategory(fakeAdapter([2026], { 2026: snap2026 }), store, { http, now: new Date('2026-04-10'), alert: quiet });
  assert(report.ok, report.problems.join());
  assertEquals(report.wrote, false);
  assertEquals(store.races.length, 0);
  assertEquals(report.changes.filter((c) => c.entity === 'race').length, 3);
});

Deno.test('live grava calendario e classificacao calculada', async () => {
  const store = new MemoryStore();
  store.config.set('test', { mode: 'live', seasonOverride: null, params: {} });
  const report = await runCategory(fakeAdapter([2026], { 2026: snap2026 }), store, { http, now: new Date('2026-04-10'), alert: quiet });
  assert(report.ok, report.problems.join());
  assertEquals(store.races.length, 3);
  const drivers = store.standings.get('test:drivers')!.set.rows;
  assertEquals(drivers.map((r) => [r.name, r.points]), [['Ana', 16], ['Bia', 16]]);
});

Deno.test('fonte vazia ou encolhida nao apaga nada', async () => {
  const store = new MemoryStore();
  store.config.set('test', { mode: 'live', seasonOverride: null, params: {} });
  const big: Snapshot = { ...snap2026, races: Array.from({ length: 8 }, (_, i) => race(i + 1, `2026-0${(i % 9) + 1}-10`, 'upcoming')), results: [] };
  await runCategory(fakeAdapter([2026], { 2026: big }), store, { http, now: new Date('2026-01-10'), alert: quiet });
  assertEquals(store.races.length, 8);
  const small: Snapshot = { ...big, races: big.races.slice(0, 2) };
  const sent: string[] = [];
  const report = await runCategory(fakeAdapter([2026], { 2026: small }), store, {
    http, now: new Date('2026-01-11'), alert: async (t) => (sent.push(t), true),
  });
  assertEquals(report.ok, false);
  assertEquals(store.races.length, 8);
  assertEquals(sent.length, 1);
});

Deno.test('classificacao oficial divergente mantem a anterior e alerta', async () => {
  const store = new MemoryStore();
  store.config.set('test', { mode: 'live', seasonOverride: null, params: {} });
  await runCategory(fakeAdapter([2026], { 2026: snap2026 }), store, { http, now: new Date('2026-04-10'), alert: quiet });
  const wrong: Snapshot = {
    ...snap2026,
    officialStandings: [{ group: 'drivers', rows: [{ position: 1, name: 'Ana', points: 99 }, { position: 2, name: 'Bia', points: 1 }] }],
  };
  const report = await runCategory(fakeAdapter([2026], { 2026: wrong }), store, { http, now: new Date('2026-04-11'), alert: quiet });
  assertEquals(report.ok, false);
  assertEquals(store.standings.get('test:drivers')!.set.rows[0].points, 16);
});

Deno.test('virada de temporada so acontece com a anterior encerrada', () => {
  const races = [race(1, '2026-10-01', 'completed', 'Ana')];
  const early = decideSeason({ available: [2026, 2027], current: 2026, currentRaces: [race(1, '2026-12-01', 'upcoming')], override: null, now: new Date('2026-11-01') });
  assertEquals(early, { season: 2026, rollover: false, reason: '2027 ja publicada, mas 2026 ainda nao terminou' });
  const later = decideSeason({ available: [2026, 2027], current: 2026, currentRaces: races, override: null, now: new Date('2026-12-01') });
  assertEquals(later.season, 2027);
  assert(later.rollover);
});

Deno.test('virada arquiva a temporada anterior e alerta', async () => {
  const store = new MemoryStore();
  store.config.set('test', { mode: 'live', seasonOverride: null, params: {} });
  const done: Snapshot = { ...snap2026, races: snap2026.races.slice(0, 2) };
  await runCategory(fakeAdapter([2026], { 2026: done }), store, { http, now: new Date('2026-06-01'), alert: quiet });
  const next: Snapshot = { season: 2027, races: [race(1, '2027-03-01', 'upcoming')], results: [], officialStandings: [] };
  const sent: string[] = [];
  const report = await runCategory(fakeAdapter([2026, 2027], { 2026: done, 2027: next }), store, {
    http, now: new Date('2026-12-01'), alert: async (t) => (sent.push(t), true),
  });
  assert(report.ok, report.problems.join());
  assertEquals(report.season, 2027);
  assertEquals(store.races.map((r) => r.season), [2027]);
  assertEquals(store.archived.length > 0, true);
  // Entre temporadas o site mostra o calendario novo e a classificacao final antiga.
  assertEquals(store.standings.get('test:drivers')!.season, 2026);
  assert(sent[0].includes('2027'));
  assert(report.warnings.some((w) => w.includes('temporada anterior')), 'deve avisar regra de pontos assumida');
});

Deno.test('correcao manual vale ate a fonte alcancar', async () => {
  const store = new MemoryStore();
  store.config.set('test', { mode: 'live', seasonOverride: null, params: {} });
  const pending: Snapshot = { ...snap2026, races: [race(1, '2026-03-01', 'completed', null)], results: [] };
  store.overrides.push({ id: 'o1', category: 'test', season: 2026, race_id: 'r1', kind: 'winner', value: 'Ana', active: true });
  await runCategory(fakeAdapter([2026], { 2026: pending }), store, { http, now: new Date('2026-03-02'), alert: quiet });
  assertEquals(store.races[0].winner, 'Ana');
  assertEquals(store.overrides[0].active, true);
  const fixed: Snapshot = { ...pending, races: [race(1, '2026-03-01', 'completed', 'Ana')] };
  await runCategory(fakeAdapter([2026], { 2026: fixed }), store, { http, now: new Date('2026-03-03'), alert: quiet });
  assertEquals(store.overrides[0].active, false);
});

Deno.test('pontos por classe e descartes', () => {
  const races = [race(1, '2026-03-01', 'completed'), race(2, '2026-04-01', 'completed')];
  const sets = computeStandings({ sessions: { race: [25, 18] }, perClass: true, drops: 1 }, races, [
    { raceId: 'r1', session: 'race', official: true, rows: [{ position: 1, driver: 'A', class: 'GTP' }, { position: 2, driver: 'B', class: 'GTD' }, { position: 3, driver: 'C', class: 'GTP' }] },
    { raceId: 'r2', session: 'race', official: true, rows: [{ position: 1, driver: 'C', class: 'GTP' }, { position: 2, driver: 'A', class: 'GTP' }] },
  ]);
  const gtp = sets.find((s) => s.group === 'class:GTP')!.rows;
  assertEquals(gtp.map((r) => [r.name, r.points]), [['A', 25], ['C', 25]]);
  assertEquals(sets.find((s) => s.group === 'class:GTD'), undefined, 'descarte zera quem so correu uma vez');
});
