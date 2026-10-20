import { assert, assertEquals } from 'jsr:@std/assert@1';
import { f2, findObjects, flightRows, sessionKey } from '../_shared/adapters/fia-formula.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';
import { validateRaces, validateStandings } from '../_shared/validate.ts';

const dir = new URL('./fixtures/f2/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const B = 'https://www.fiaformula2.com';
const SLUGS = [
  'melbourne', 'miami-gardens', 'montreal', 'monte-carlo', 'barcelona', 'spielberg', 'silverstone',
  'spa-francorchamps', 'budapest', 'monza', 'madrid', 'baku', 'lusail', 'yas-marina',
];

// Recortes reais de 2026-10-20 (payload RSC reduzido ao objeto usado).
const http = fixtureHttp({
  [`${B}/en/standings/2026/drivers`]: read('standings_2026_drivers.rsc'),
  [`${B}/en/standings/2026/teams`]: read('standings_2026_teams.rsc'),
  [`${B}/en/standings/2027/drivers`]: read('standings_2027_drivers.rsc'),
  ...Object.fromEntries(SLUGS.map((s) => [`${B}/en/racing/2026/${s}`, read(`race_${s}.rsc`)])),
});
const ctx = { http, now: new Date('2026-10-20T12:00:00Z'), params: {} };

Deno.test('flight: le RSC cru, HTML com __next_f e pula linhas de texto', () => {
  const raw = '1:"$Sreact.fragment"\n2:I["x",[],"default"]\n3:T5,ab\ncd4:{"meetings":[],"standings":[1]}\n';
  assertEquals(findObjects(flightRows(raw), (o) => 'meetings' in o), [{ meetings: [], standings: [1] }]);
  const html = `<script>self.__next_f.push([0])</script><script>self.__next_f.push([1,${JSON.stringify('5:{"a":{"meetingSessions":[],')}])</script>` +
    `<script>self.__next_f.push([1,${JSON.stringify('"meetingKey":"9"}}\n')}])</script>`;
  assertEquals(findObjects(flightRows(html), (o) => 'meetingKey' in o), [{ meetingSessions: [], meetingKey: '9' }]);
  assertEquals([sessionKey('Sprint Race', 1), sessionKey('Feature Race', 2), sessionKey('Feature Race 2', 3), sessionKey('Race', 4)], ['sprint', 'feature', 'feature2', 'race4']);
});

Deno.test('f2: temporadas testando o ano atual e o seguinte', async () => {
  assertEquals(await f2.listSeasons(ctx), [2026], '2027 ainda sem etapas');
});

Deno.test('f2: calendario 2026 com vencedores das features', async () => {
  const snap = await f2.fetchSnapshot(ctx, 2026);
  assertEquals(snap.races.length, 14);
  assertEquals(snap.races.map((r) => r.raceId), SLUGS.map((s, i) => `r${String(i + 1).padStart(2, '0')}-${s}`));
  assertEquals(snap.races.map((r) => r.winner), [
    'Nikola Tsolov', 'Gabriele Mini', 'Martinius Stenshorne', 'Nikola Tsolov', 'Rafael Câmara', 'Nikola Tsolov', 'Nikola Tsolov',
    'Rafael Câmara', 'Noel Leon', 'Joshua Dürksen', 'Dino Beganovic', 'Rafael Câmara', null, null,
  ]);
  const by = (id: string) => snap.races.find((r) => r.raceId === id)!;
  assertEquals([by('r04-monte-carlo').name, by('r02-miami-gardens').name, by('r14-yas-marina').name], ['Mônaco', 'Miami', 'Abu Dhabi']);
  const baku = by('r12-baku');
  assertEquals([baku.date, baku.startsAt, baku.status, baku.circuit], ['2026-09-26', '2026-09-26T07:00:00Z', 'completed', 'Baku City Circuit']);
  assertEquals(baku.enName, 'FORMULA 1 QATAR AIRWAYS AZERBAIJAN GRAND PRIX 2026');
  const mel = by('r01-melbourne');
  assertEquals([mel.date, mel.startsAt], ['2026-03-08', '2026-03-08T00:25:00Z']);
  const lus = by('r13-lusail');
  assertEquals([lus.status, lus.date, lus.startsAt], ['upcoming', '2026-11-29', '2026-11-29T09:00:00Z']);
});

Deno.test('f2: resultados (classificacao completa so da ultima corrida da etapa)', async () => {
  const snap = await f2.fetchSnapshot(ctx, 2026);
  assert(!snap.results.some((r) => r.raceId === 'r13-lusail' || r.raceId === 'r14-yas-marina'));
  assertEquals(snap.results.filter((r) => r.raceId === 'r12-baku').map((r) => r.session), ['sprint', 'feature1', 'feature2']);
  const bakuF2 = snap.results.find((r) => r.raceId === 'r12-baku' && r.session === 'feature2')!;
  assertEquals(bakuF2.rows.length, 22);
  assertEquals(bakuF2.rows[1], { position: 2, driver: 'Nikola Tsolov', team: 'Campos Racing', number: '6', status: null, laps: 29, points: 19 });
  const bakuF1 = snap.results.find((r) => r.raceId === 'r12-baku' && r.session === 'feature1')!;
  assertEquals([bakuF1.rows[0].driver, bakuF1.rows[0].points, bakuF1.rows[0].position], ['Alexander Dunne', 28, null]);
  const melF = snap.results.find((r) => r.raceId === 'r01-melbourne' && r.session === 'feature')!;
  const beg = melF.rows.find((r) => r.driver === 'Dino Beganovic')!;
  assertEquals([beg.position, beg.status, beg.points], [null, 'DNF', 2], 'abandonou mas leva os 2 da pole');
});

Deno.test('f2: classificacao calculada bate com a oficial', async () => {
  const snap = await f2.fetchSnapshot(ctx, 2026);
  const off = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(off.asOfRound, 12);
  assertEquals(off.rows.slice(0, 3).map((r) => [r.name, r.team, r.points]), [
    ['Rafael Câmara', 'Invicta Racing', 207], ['Nikola Tsolov', 'Campos Racing', 200], ['Alexander Dunne', 'Rodin Motorsport', 189],
  ]);
  const calc = computeStandings(f2.rules![2026], snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(calc.rows, off.rows);
  assert(cmp.matches, cmp.differences.join('; '));
  assertEquals(snap.officialStandings.find((s) => s.group === 'teams')?.rows[0], { position: 1, name: 'Campos Racing', points: 333 });
  for (const set of snap.officialStandings) assertEquals(validateStandings(set, []).problems, []);
  assertEquals(validateRaces(snap, { races: [], standings: [] }), { problems: [], warnings: [] });
});
