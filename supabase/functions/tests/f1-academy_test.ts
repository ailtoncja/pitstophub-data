import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adapter, cleanName, sessionKey } from '../_shared/adapters/f1-academy.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';
import { validateRaces, validateStandings } from '../_shared/validate.ts';

const dir = new URL('./fixtures/f1-academy/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const B = 'https://www.f1academy.com/Racing-Series';

// Recortes reais de 2026-10-20 (__NEXT_DATA__ so com os campos usados).
// Sem fixture para Results das etapas 5 e 6: o adaptador nao pode pedir.
const http = fixtureHttp({
  [`${B}/Calendar`]: read('calendar.html'),
  [`${B}/Standings/Driver?seasonId=4`]: read('standings_driver.html'),
  [`${B}/Standings/Team?seasonId=4`]: read('standings_team.html'),
  ...Object.fromEntries([22, 24, 25, 26].map((id) => [`${B}/Results?raceid=${id}`, read(`results_${id}.html`)])),
});
const ctx = { http, now: new Date('2026-10-20T12:00:00Z'), params: {} };

Deno.test('f1-academy: temporadas pela lista do site', async () => {
  assertEquals(await adapter.listSeasons(ctx), [2023, 2024, 2025, 2026]);
});

Deno.test('f1-academy: nomes e sessoes', () => {
  assertEquals(cleanName('Alisha  Palmowski'), 'Alisha Palmowski');
  assertEquals(cleanName('Chiara Bättig (WCD)'), 'Chiara Bättig');
  assertEquals(['Opening Race', 'Reverse Grid Race', 'Feature Race'].map(sessionKey), ['opening', 'reverse', 'feature']);
});

Deno.test('f1-academy: calendario 2026', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  assertEquals(snap.races.map((r) => r.raceId), ['r01-shanghai', 'r02-montreal', 'r03-silverstone', 'r04-zandvoort', 'r05-austin', 'r06-las-vegas']);
  const [sha, mon, sil, zan, aus, lv] = snap.races;
  assertEquals([sha.name, sha.date, sha.startsAt, sha.status, sha.winner], ['Xangai', '2026-03-15', '2026-03-15T02:40:00Z', 'completed', 'Emma Felbermayr']);
  assertEquals(sha.circuit, 'Shanghai International Circuit');
  assertEquals([mon.winner, sil.winner, zan.winner], ['Alisha Palmowski', 'Alisha Palmowski', 'Alisha Palmowski']);
  assertEquals(mon.startsAt, '2026-05-24T14:45:00Z');
  assertEquals([aus.status, aus.date, aus.startsAt, aus.winner], ['upcoming', '2026-10-25', '2026-10-25T17:00:00Z', null]);
  assertEquals([lv.name, lv.date], ['Las Vegas', '2026-11-21']);
  assert(snap.races.every((r) => r.official !== false));
});

Deno.test('f1-academy: resultados por sessao com pontos da fonte', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  assertEquals(snap.results.length, 9, '2 corridas x 3 etapas + 3 em Montreal');
  assertEquals(snap.results.filter((r) => r.raceId === 'r02-montreal').map((r) => r.session), ['opening', 'reverse', 'feature']);
  assert(!snap.results.some((r) => r.raceId === 'r05-austin'));
  const silFr = snap.results.find((r) => r.raceId === 'r03-silverstone' && r.session === 'feature')!;
  assertEquals(silFr.rows[0], { position: 1, driver: 'Alisha Palmowski', team: 'Campos Racing', number: '21', status: null, laps: 13, points: 26 });
  assertEquals(silFr.rows[1].driver, 'Chiara Bättig');
  const stevens = silFr.rows.find((r) => r.driver === 'Ella Stevens')!;
  assertEquals([stevens.position, stevens.status], [null, 'Ret']);
  const shaRg = snap.results.find((r) => r.raceId === 'r01-shanghai' && r.session === 'reverse')!;
  assertEquals([shaRg.rows[0].driver, shaRg.rows[0].points], ['Nina Gademan', 10]);
});

Deno.test('f1-academy: classificacao calculada bate com a oficial', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  const off = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(off.asOfRound, 4);
  assertEquals(off.rows.slice(0, 3).map((r) => [r.name, r.points]), [['Alisha Palmowski', 136], ['Emma Felbermayr', 88], ['Nina Gademan', 71]]);
  assertEquals(off.rows.find((r) => r.name === 'Chiara Bättig')?.points, 22);
  const calc = computeStandings(adapter.rules![2026], snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(calc.rows, off.rows);
  assert(cmp.matches, cmp.differences.join('; '));
  assertEquals(snap.officialStandings.find((s) => s.group === 'teams')?.rows[0], { position: 1, name: 'Campos Racing', team: null, points: 212 });
  for (const set of snap.officialStandings) assertEquals(validateStandings(set, []).problems, []);
  assertEquals(validateRaces(snap, { races: [], standings: [] }), { problems: [], warnings: [] });
});
