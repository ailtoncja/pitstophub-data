import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { parseSelect, seasonYear, titleName, wec } from '../_shared/adapters/alkamel.ts';
import { runCategory } from '../_shared/engine.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { MemoryStore } from '../_shared/memory-store.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';

// Recortes reais de 2026-10-20: indice e paginas de evento da Al Kamel (so os
// links que interessam), CSVs de corrida/Hyperpole e fiawec.com/en/season/2026
// (calendario + classificacoes de pilotos).
const dir = new URL('./fixtures/wec/', import.meta.url);
const urls: Record<string, string> = JSON.parse(Deno.readTextFileSync(new URL('urls.json', dir)));
const files = Object.fromEntries(Object.entries(urls).map(([u, f]) => [u, Deno.readTextFileSync(new URL(f, dir))]));
const ctx = () => ({ http: fixtureHttp(files), now: new Date('2026-10-20T12:00:00Z'), params: {} as Record<string, unknown> });

Deno.test('wec: temporadas pelo select da Al Kamel', async () => {
  const seasons = await wec.listSeasons(ctx());
  assertEquals(seasons[0], 2011);
  assertEquals(seasons.at(-1), 2026);
  assert(seasons.includes(2018) && seasons.includes(2019), '2018-2019 e 2019-2020 viram 2018 e 2019');
  assertEquals(seasonYear('2018-2019'), 2018);
  assertEquals(parseSelect(files['https://fiawec.alkamelsystems.com/'], 'season').find((o) => o.selected)?.value, '15_2026');
});

Deno.test('wec: calendario com etapa futura e vencedores do Hypercar', async () => {
  const snap = await wec.fetchSnapshot(ctx(), 2026);
  assertEquals(snap.races.map((r) => r.raceId), [
    'r01-imola', 'r02-spa', 'r03-le-mans', 'r04-interlagos', 'r05-austin', 'r06-fuji', 'r07-barcelona', 'r08-monza',
  ]);
  const by = (id: string) => snap.races.find((r) => r.raceId === id)!;
  assertEquals(by('r01-imola').winner, 'Sébastien Buemi / Brendon Hartley / Ryo Hirakawa');
  assert(by('r02-spa').winner!.includes('Robin Frijns'));
  assertEquals(by('r03-le-mans').winner, 'Mike Conway / Kamui Kobayashi / Nyck De Vries');
  assertEquals([by('r03-le-mans').enName, by('r03-le-mans').date], ['24 Hours of Le Mans', '2026-06-13']);
  assert(by('r04-interlagos').winner!.includes('Kevin Magnussen'));
  assertEquals(by('r06-fuji').enName, '6 Hours of Fuji');
  assertEquals(by('r07-barcelona').date, '2026-10-18');
  const monza = by('r08-monza');
  assertEquals([monza.status, monza.date, monza.enName, monza.winner], ['upcoming', '2026-11-08', '6 Hours of Monza', null]);
  assert(snap.races.slice(0, 7).every((r) => r.status === 'completed' && r.official));
  assert(snap.notes!.some((n) => n.startsWith('Fuji')), 'Fuji sem Hyperpole (cancelada)');
});

Deno.test('wec: uma linha por piloto, pole por classe e convidados de Le Mans fora', async () => {
  const snap = await wec.fetchSnapshot(ctx(), 2026);
  const race = snap.results.find((r) => r.raceId === 'r07-barcelona' && r.session === 'race')!;
  const car8 = race.rows.filter((r) => r.number === '8');
  assertEquals(car8.map((r) => [r.driver, r.position, r.class]), [
    ['Sébastien Buemi', 1, 'HYPERCAR'], ['Brendon Hartley', 1, 'HYPERCAR'], ['Ryo Hirakawa', 1, 'HYPERCAR'],
  ]);
  assert(!race.rows.some((r) => r.class === 'LMP2'));
  const pole = snap.results.find((r) => r.raceId === 'r07-barcelona' && r.session === 'pole')!;
  assertEquals([...new Set(pole.rows.map((r) => `${r.class}#${r.number}`))].length, 2);
  assert(pole.rows.some((r) => r.class === 'HYPERCAR' && r.number === '17'));
  // Le Mans: pole em sessao propria (nao dobra) e carros so de Le Mans sem posicao.
  const lmPole = snap.results.find((r) => r.raceId === 'r03-le-mans' && r.session.startsWith('pole'))!;
  assertEquals(lmPole.session, 'pole-le-mans');
  assert(lmPole.rows.some((r) => r.class === 'HYPERCAR' && r.number === '15'));
  const lm = snap.results.find((r) => r.raceId === 'r03-le-mans' && r.session === 'race')!;
  const guest = lm.rows.find((r) => r.number === '150')!;
  assertEquals(guest.position, null);
  assert(guest.status!.includes('convidado'));
  assert(!snap.results.some((r) => r.raceId === 'r06-fuji' && r.session === 'pole'));
});

Deno.test('wec: classificacao calculada bate com a oficial (Hypercar e LMGT3)', async () => {
  const snap = await wec.fetchSnapshot(ctx(), 2026);
  const computed = computeStandings(wec.rules![2026], snap.races, snap.results);
  for (const group of ['drivers', 'class:LMGT3']) {
    const calc = computed.find((s) => s.group === group)!;
    const off = snap.officialStandings.find((s) => s.group === group)!;
    assertEquals(off.asOfRound, 7);
    assert(compareStandings(calc.rows, off.rows).matches, group);
    // Todos os pilotos, nao so o top 10.
    const offPts = new Map(off.rows.map((r) => [r.name, r.points]));
    for (const row of calc.rows) assertEquals(row.points, offPts.get(row.name), `${group} ${row.name}`);
  }
  const drivers = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(drivers.rows.slice(0, 4).map((r) => [r.position, r.name, r.points]), [
    [1, 'Brendon Hartley', 114], [1, 'Ryo Hirakawa', 114], [1, 'Sébastien Buemi', 114], [4, 'Kamui Kobayashi', 97],
  ]);
  const gt3 = snap.officialStandings.find((s) => s.group === 'class:LMGT3')!;
  assertEquals([gt3.rows[0].name, gt3.rows[0].points], ['Jonny Edgar', 92]);
});

Deno.test('wec: motor publica drivers (Hypercar) e LMGT3 sem problemas', async () => {
  const store = new MemoryStore();
  store.config.set('wec', { mode: 'live', seasonOverride: null, params: {} });
  const report = await runCategory(wec, store, { http: fixtureHttp(files), now: new Date('2026-10-20T12:00:00Z'), alert: () => Promise.resolve(true) });
  assert(report.ok, report.problems.join(' | '));
  assertEquals(report.asOfRound, 7);
  assertEquals(store.standings.get('wec:drivers')!.set.rows[0].points, 114);
  assertEquals(store.standings.get('wec:class:LMGT3')!.set.rows[0].name, 'Jonny Edgar');
});

Deno.test('wec: pagina errada da CDN vira erro, nao dado misturado', async () => {
  const wrong = { ...files };
  const imola = Object.keys(wrong).find((u) => u.endsWith('evvent=01_IMOLA'))!;
  wrong[imola] = files['https://fiawec.alkamelsystems.com/'];
  await assertRejects(() => wec.fetchSnapshot({ ...ctx(), http: fixtureHttp(wrong) }, 2026), Error, 'outra pagina');
});

Deno.test('wec: nomes em maiusculas viram nome proprio', () => {
  assertEquals(titleName('Sébastien BUEMI'), 'Sébastien Buemi');
  assertEquals(titleName('RYŌ HIRAKAWA'), 'Ryō Hirakawa');
  assertEquals(titleName('Paul-Loup CHATIN'), 'Paul-Loup Chatin');
});
