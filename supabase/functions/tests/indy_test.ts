import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adapter, easternToUtc, parseSchedule } from '../_shared/adapters/indy.ts';
import { pickDefaultRules } from '../_shared/engine.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';

const dir = new URL('./fixtures/indy/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const API = 'https://www.indycar.com/api/results';
const G = 'b856a4f1-e85c-4fac-8c36-fd58d962227a';
const SESSIONS = [6732, 6733, 6734, 6735, 6736, 6737, 6738, 6739, 6740, 6741, 6742, 6743, 6744, 6745, 6746, 6747, 6748, 6796];

// Recortes reais de 2026-10-20 (temporada 2026 encerrada; 2027 so com calendario).
const http = fixtureHttp({
  [`${API}/YearsBySeries?series=${G}`]: read('years.json'),
  [`${API}/YearPointSummary?year=2026&id=${G}`]: read('point_summary_2026.json'),
  [`${API}/YearPointSummary?year=2027&id=${G}`]: read('point_summary_2027.json'),
  [`${API}/SeasonDropDown?id=${G}`]: read('season_dropdown.json'),
  'https://www.indycar.com/schedule': read('schedule.html'),
  ...Object.fromEntries(SESSIONS.map((id) => [`${API}/EventsSessionDetails?id=${id}`, read(`session_${id}.json`)])),
});
const ctx = (now: string) => ({ http, now: new Date(now), params: {} });

Deno.test('indy: temporadas da lista de anos + calendario seguinte ja publicado', async () => {
  assertEquals(await adapter.listSeasons(ctx('2026-10-20T12:00:00Z')), [2025, 2026, 2027]);
});

Deno.test('indy: calendario e vencedores de 2026', async () => {
  const snap = await adapter.fetchSnapshot(ctx('2026-10-20T12:00:00Z'), 2026);
  assertEquals(snap.races.length, 18);
  assertEquals(snap.results.length, 18);
  const first = snap.races[0];
  assertEquals([first.raceId, first.name, first.date, first.startsAt, first.winner], [
    'r01-st-petersburg',
    'St. Petersburg',
    '2026-03-01',
    '2026-03-01T17:00:00Z',
    'Alex Palou',
  ]);
  assertEquals(first.location, 'St. Petersburg, Florida');
  const indy500 = snap.races.find((r) => r.raceId === 'r07-indy-500')!;
  assertEquals([indy500.enName, indy500.winner, indy500.circuit], [
    '110th Running of the Indianapolis 500',
    'Felix Rosenqvist',
    'Indianapolis Motor Speedway',
  ]);
  // Rodada dupla de Milwaukee no mesmo dia, em ordem de largada.
  assertEquals(snap.races.slice(15, 17).map((r) => [r.raceId, r.enName, r.startsAt]), [
    ['r16-milwaukee-1', 'Snap-on Milwaukee Mile 250', '2026-08-30T17:00:00Z'],
    ['r17-milwaukee-2', 'Snap-on Makers and Fixers 250', '2026-08-30T22:00:00Z'],
  ]);
  const last = snap.races.at(-1)!;
  assertEquals([last.raceId, last.date, last.winner], ['r18-laguna-seca', '2026-09-06', 'Scott McLaughlin']);
  assert(snap.races.every((r) => r.status === 'completed'));
});

Deno.test('indy: classificacao calculada pelos pontos da fonte bate com a oficial', async () => {
  const snap = await adapter.fetchSnapshot(ctx('2026-10-20T12:00:00Z'), 2026);
  const official = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(official.rows[0], { position: 1, name: 'Alex Palou', team: 'Chip Ganassi Racing', points: 631 });
  assertEquals(official.asOfRound, 18);
  const { rules } = pickDefaultRules(adapter, 2026);
  const computed = computeStandings(rules!, snap.races, snap.results).find((s) => s.group === 'drivers')!;
  assertEquals(computed.rows.slice(0, 3).map((r) => [r.name, r.points]), [['Alex Palou', 631], ['Kyle Kirkwood', 545], [
    'Christian Lundgaard',
    535,
  ]]);
  assert(compareStandings(computed.rows, official.rows).matches);
});

Deno.test('indy: corrida futura no calendario nao busca detalhe', async () => {
  // Simula 1/5: as fixtures tem o detalhe de todas, mas so as 5 primeiras devem ser lidas;
  // as demais ficam "upcoming" com a data do calendario.
  const snap = await adapter.fetchSnapshot(ctx('2026-05-01T12:00:00Z'), 2026);
  assertEquals(snap.races.length, 18);
  const done = snap.races.filter((r) => r.status === 'completed');
  assertEquals(done.map((r) => r.round), [1, 2, 3, 4, 5]);
  assertEquals(snap.races.find((r) => r.round === 12)!.date, '2026-07-20');
});

Deno.test('indy: horario ET para UTC e leitura do calendario', () => {
  assertEquals(easternToUtc('2026-03-01', '12:00 PM ET'), '2026-03-01T17:00:00Z');
  assertEquals(easternToUtc('2026-03-08', '12:00 PM ET'), '2026-03-08T16:00:00Z');
  assertEquals(easternToUtc('2026-06-07', '9:00 PM ET'), '2026-06-08T01:00:00Z');
  assertEquals(easternToUtc('2026-06-07', 'TBA'), null);
  const cards = parseSchedule(read('schedule.html'));
  assertEquals(cards.length, 18);
  assertEquals(cards.find((c) => c.slug === 'Barber')!.title, "Children's of Alabama Indy Grand Prix");
});
