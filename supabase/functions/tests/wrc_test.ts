import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adapter, breakdown, personName, rules } from '../_shared/adapters/wrc.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';

const dir = new URL('./fixtures/wrc/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const B = 'https://p-p.redbull.com/rb-wrccom-lintegration-yv-prod/api';

// Recortes reais de 2026-10-20. events_2026.json junta, por rali, o
// events/{id}.json, o top 3 do results.json e as inscricoes desse top 3.
const events = JSON.parse(read('events_2026.json')) as Record<
  string,
  { event: { rallies: { rallyId: number }[] }; results: unknown; entries: unknown }
>;
const base: Record<string, string> = {
  [`${B}/seasons.json`]: read('seasons.json'),
  [`${B}/season-detail.json?seasonId=47`]: read('season_detail_47.json'),
  [`${B}/championship-detail.json?championshipId=333&seasonId=47`]: read('championship_detail_333.json'),
  [`${B}/championship-overall-results.json?championshipId=333&seasonId=47`]: read('championship_overall_333.json'),
};
const perRally: Record<string, string> = {};
for (const [id, e] of Object.entries(events)) {
  const rally = `${B}/events/${id}/rallies/${e.event.rallies[0].rallyId}`;
  perRally[`${B}/events/${id}.json`] = JSON.stringify(e.event);
  perRally[`${rally}/results.json`] = JSON.stringify(e.results);
  perRally[`${rally}/entries.json`] = JSON.stringify(e.entries);
}
const now = new Date('2026-10-20T12:00:00Z');
const ctx = () => ({ http: fixtureHttp({ ...base, ...perRally }), now, params: {} as Record<string, unknown> });

Deno.test('wrc: utilitarios', () => {
  assertEquals(personName('Elfyn', 'EVANS'), 'Elfyn Evans');
  assertEquals(personName('Josh', 'MCERLEAN'), 'Josh McErlean');
  assertEquals(personName('Sébastien', 'OGIER'), 'Sébastien Ogier');
  assertEquals(breakdown('25 + 5 + 4'), [25, 5, 4]);
  assertEquals(breakdown('-'), []);
  assertEquals(breakdown('R'), []);
});

Deno.test('wrc: temporadas so do WRC (sem ERC), com 2027 ja publicada', async () => {
  assertEquals(await adapter.listSeasons(ctx()), [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]);
});

Deno.test('wrc: calendario 2026 e vencedores', async () => {
  const snap = await adapter.fetchSnapshot(ctx(), 2026);
  assertEquals(snap.races.length, 13);
  assert(snap.races.every((r) => r.status === 'completed' && r.official));
  const by = (round: number) => snap.races.find((r) => r.round === round)!;
  assertEquals([by(1).raceId, by(1).name, by(1).enName, by(1).date], [
    'r01-monte-carlo',
    'Monte Carlo',
    'Rallye Monte Carlo',
    '2026-01-25',
  ]);
  assertEquals([by(13).raceId, by(13).date, by(13).winner], ['r13-sardenha', '2026-10-04', 'Oliver Solberg']);
  assertEquals(by(2).winner, 'Elfyn Evans');
  assertEquals(by(10).winner, 'Sami Pajari');
  assertEquals(by(5).name, 'Ilhas Canárias');
});

Deno.test('wrc: pontos geral + Super Sunday + Power Stage batem com a oficial', async () => {
  const c = ctx();
  const snap = await adapter.fetchSnapshot(c, 2026);
  const sar = (session: string) => snap.results.find((r) => r.raceId === 'r13-sardenha' && r.session === session)!;
  assertEquals(sar('race').rows[0], {
    position: 1,
    driver: 'Oliver Solberg',
    team: 'TOYOTA GAZOO RACING WRT',
    status: 'Finished',
    points: 25,
  });
  assertEquals(sar('supersunday').rows.map((r) => [r.driver, r.points]).slice(0, 2), [['Sami Pajari', 5], ['Oliver Solberg', 4]]);
  assertEquals(sar('powerstage').rows[0].driver, 'Thierry Neuville');

  const official = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(official.rows.slice(0, 3).map((r) => [r.name, r.points]), [['Elfyn Evans', 243], ['Oliver Solberg', 238], [
    'Sami Pajari',
    237,
  ]]);
  assertEquals(official.asOfRound, 13);
  const computed = computeStandings(rules[2026], snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(computed.rows, official.rows);
  assert(cmp.matches, cmp.differences.join('; '));
  // Vencedores ficam em params: a proxima execucao nao refaz 39 pedidos.
  assertEquals(Object.keys(c.params.wrcWinners as object).length, 13);
});

Deno.test('wrc: com vencedores em cache nao busca resultado de cada rali', async () => {
  const first = ctx();
  await adapter.fetchSnapshot(first, 2026);
  const snap = await adapter.fetchSnapshot({ http: fixtureHttp(base), now, params: first.params }, 2026);
  assertEquals(snap.races.find((r) => r.round === 13)!.winner, 'Oliver Solberg');
  assertEquals(snap.notes, []);
});
