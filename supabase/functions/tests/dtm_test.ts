import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adapter, driverName, rules, shortEventName } from '../_shared/adapters/dtm.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';

const dir = new URL('./fixtures/dtm/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const B = 'https://api.dtm.com/data';
const R = 'raceSeries=DTM&startDate=2026-01-01&endDate=2026-12-31&lang=en';

// Recortes reais de 2026-10-20 (api.dtm.com): eventos sem imagens, so as
// sessoes "Race N" do wigeResults e a classificacao sem o detalhe por corrida.
const http = fixtureHttp({
  [`${B}?query=events&lang=en`]: read('events.json'),
  [`${B}?query=wigeResults&${R}`]: read('wigeResults_2026.json'),
  [`${B}?query=wigeStandings&${R}`]: read('wigeStandings_2026.json'),
});
const ctx = { http, now: new Date('2026-10-20T12:00:00Z'), params: {} };

Deno.test('dtm: nomes no formato do app', () => {
  assertEquals(driverName('PREINING Thomas'), 'Thomas Preining');
  assertEquals(driverName('VAN DER LINDE Kelvin'), 'Kelvin van der Linde');
  assertEquals(driverName('DÖRR Ben'), 'Ben Dörr');
  assertEquals(shortEventName('Red Bull Ring by VKB-Bank'), 'Red Bull Ring');
  assertEquals(shortEventName('Motorsport Arena Oschersleben'), 'Oschersleben');
  assertEquals(shortEventName('Lausitzring Turn 1 powered by Autohero'), 'Lausitzring Turn 1');
});

Deno.test('dtm: temporadas vem do calendario da fonte (2027 ja publicado)', async () => {
  assertEquals(await adapter.listSeasons(ctx), [2022, 2023, 2024, 2025, 2026, 2027]);
});

Deno.test('dtm: calendario e vencedores 2026', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  assertEquals(snap.races.length, 8);
  assertEquals(snap.races.map((r) => r.raceId), [
    'r01-red-bull-ring',
    'r02-zandvoort',
    'r03-lausitzring',
    'r04-norisring',
    'r05-oschersleben',
    'r06-nurburgring',
    'r07-sachsenring',
    'r08-hockenheimring',
  ]);
  assert(snap.races.every((r) => r.status === 'completed' && r.official === true));
  const by = (round: number) => snap.races.find((r) => r.round === round)!;
  // Final em Hockenheim: Auer venceu a Corrida 1, Engel a Corrida 2.
  assertEquals([by(8).date, by(8).winner, by(8).startsAt], ['2026-10-11', 'Lucas Auer / Maro Engel', '2026-10-11T14:30:00Z']);
  // Norisring: Thiim venceu as duas -> um nome so.
  assertEquals(by(4).winner, 'Nicki Thiim');
  // Inicio as 22:00 UTC = meia-noite local: data fica no fuso da Alemanha.
  assertEquals(by(1).date, '2026-04-26');
  assertEquals([by(1).name, by(1).enName, by(1).location], ['Red Bull Ring', 'Red Bull Ring by VKB-Bank', 'Áustria']);
});

Deno.test('dtm: pontos das linhas somam a classificacao oficial', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  assertEquals(snap.results.length, 32, '8 rodadas x (2 corridas + 2 quali)');
  const r1 = snap.results.find((r) => r.raceId === 'r01-red-bull-ring' && r.session === 'race1')!;
  assertEquals(r1.rows[0], {
    position: 1,
    driver: 'Thomas Preining',
    team: 'Manthey',
    number: '91',
    status: 'Finished',
    laps: 38,
    points: 25,
  });
  const q1 = snap.results.find((r) => r.raceId === 'r01-red-bull-ring' && r.session === 'qualifying1')!;
  assertEquals(q1.rows.map((r) => [r.driver, r.points]), [['Maro Engel', 3], ['Ben Dörr', 2], ['Thomas Preining', 1]]);

  const drivers = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(drivers.rows.slice(0, 3).map((r) => [r.name, r.points]), [['Thomas Preining', 225], ['Maro Engel', 213], [
    'Marco Wittmann',
    198,
  ]]);
  assertEquals(drivers.asOfRound, 8);
  assert(snap.officialStandings.some((s) => s.group === 'teams' && s.rows[0].name === 'Manthey'));

  const computed = computeStandings(rules[2026], snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(computed.rows, drivers.rows);
  assert(cmp.matches, cmp.differences.join('; '));
});

Deno.test('dtm: fim de semana pela metade nao publica oficial', async () => {
  // Simula o sabado da final: so a Corrida 1 de Hockenheim publicada.
  const res = JSON.parse(read('wigeResults_2026.json'));
  res.wigeResultses = res.wigeResultses.filter((x: { wigeEventId: number; jsonText: string }) =>
    !(x.wigeEventId === 202608 && JSON.parse(x.jsonText).result[0].name === 'ENGEL Maro')
  );
  const partial = fixtureHttp({
    [`${B}?query=events&lang=en`]: read('events.json'),
    [`${B}?query=wigeResults&${R}`]: JSON.stringify(res),
    [`${B}?query=wigeStandings&${R}`]: read('wigeStandings_2026.json'),
  });
  const snap = await adapter.fetchSnapshot({ ...ctx, http: partial, now: new Date('2026-10-10T18:00:00Z') }, 2026);
  const fin = snap.races.at(-1)!;
  assertEquals([fin.status, fin.winner], ['upcoming', null]);
  assertEquals(snap.officialStandings.length, 0);
  assert(snap.notes!.some((n) => n.includes('andamento')));
});
