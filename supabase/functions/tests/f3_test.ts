import { assert, assertEquals } from 'jsr:@std/assert@1';
import { f3 } from '../_shared/adapters/fia-formula.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';
import { validateStandings } from '../_shared/validate.ts';

const dir = new URL('./fixtures/f3/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const B = 'https://www.fiaformula3.com';
const SLUGS = ['melbourne', 'monte-carlo', 'barcelona', 'spielberg', 'silverstone', 'spa-francorchamps', 'budapest', 'monza', 'madrid'];

// Recortes reais de 2026-10-20: temporada 2026 da F3 ja encerrada.
const http = fixtureHttp({
  [`${B}/en/standings/2026/drivers`]: read('standings_2026_drivers.rsc'),
  [`${B}/en/standings/2026/teams`]: read('standings_2026_teams.rsc'),
  [`${B}/en/standings/2027/drivers`]: read('standings_2027_drivers.rsc'),
  ...Object.fromEntries(SLUGS.map((s) => [`${B}/en/racing/2026/${s}`, read(`race_${s}.rsc`)])),
});
const ctx = { http, now: new Date('2026-10-20T12:00:00Z'), params: {} };

Deno.test('f3: temporadas', async () => {
  assertEquals(await f3.listSeasons(ctx), [2026]);
});

Deno.test('f3: temporada completa, Madrid com 3 corridas', async () => {
  const snap = await f3.fetchSnapshot(ctx, 2026);
  assertEquals(snap.races.length, 9);
  assert(snap.races.every((r) => r.status === 'completed'));
  assertEquals(snap.races.map((r) => r.winner), [
    'Ugo Ugochukwu', 'Brando Badoer', 'Théophile Naël', 'Noah Stromsted', 'Maciej Gladysz', 'Ernesto Rivera', 'Freddie Slater',
    'Nicola Lacorte', 'Tuukka Taponen',
  ]);
  const mad = snap.races.at(-1)!;
  assertEquals([mad.raceId, mad.name, mad.date], ['r09-madrid', 'Madrid', '2026-09-13']);
  assertEquals(snap.results.filter((r) => r.raceId === 'r09-madrid').map((r) => r.session), ['sprint', 'feature1', 'feature2']);
  const madF1 = snap.results.find((r) => r.raceId === 'r09-madrid' && r.session === 'feature1')!;
  assertEquals([madF1.rows[0].driver, madF1.rows[0].points], ['Pedro Clerot', 25]);
  // Sprint de Melbourne valeu meia pontuacao: maximo 5.
  const melS = snap.results.find((r) => r.raceId === 'r01-melbourne' && r.session === 'sprint')!;
  assertEquals(Math.max(...melS.rows.map((r) => r.points ?? 0)), 5);
});

Deno.test('f3: classificacao final bate com a calculada', async () => {
  const snap = await f3.fetchSnapshot(ctx, 2026);
  const off = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(off.rows.slice(0, 3).map((r) => [r.name, r.points]), [['Ugo Ugochukwu', 159], ['Freddie Slater', 145], ['Tuukka Taponen', 109]]);
  const calc = computeStandings(f3.rules![2026], snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(calc.rows, off.rows);
  assert(cmp.matches, cmp.differences.join('; '));
  assertEquals(snap.officialStandings.find((s) => s.group === 'teams')?.rows[0].name, 'Campos Racing');
  // A fonte pula a 34a posicao (vai de 33 para 35): renumerada para passar na validacao.
  assertEquals(off.rows.at(-1), { position: 34, name: 'Salim Hanna', team: off.rows.at(-1)!.team, points: 0 });
  for (const set of snap.officialStandings) assertEquals(validateStandings(set, []).problems, []);
});
