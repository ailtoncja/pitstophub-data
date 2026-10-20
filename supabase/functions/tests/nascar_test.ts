import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adapter, shortTrackName } from '../_shared/adapters/nascar.ts';
import { fixtureHttp } from '../_shared/http.ts';

const dir = new URL('./fixtures/nascar/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const B = 'https://cf.nascar.com/cacher/2026';

// Recortes reais de 2026-10-20 (feeds cacher). So 4 weekend-feeds gravados:
// os demais respondem 404 e o adaptador usa o nome do feed de pontos.
const http = fixtureHttp({
  [`${B}/race_list_basic.json`]: read('race_list_basic_2026.json'),
  [`${B}/1/racinginsights-points-feed.json`]: read('points_feed_2026.json'),
  ...Object.fromEntries([5619, 5629, 5630, 5633].map((id) => [`${B}/1/${id}/weekend-feed.json`, read(`weekend_feed_${id}.json`)])),
});
const ctx = { http, now: new Date('2026-10-20T12:00:00Z'), params: {} };

Deno.test('nascar: temporadas pela existencia do arquivo do ano', async () => {
  assertEquals(await adapter.listSeasons(ctx), [2026]);
});

Deno.test('nascar: calendario so com corridas que pontuam', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  assertEquals(snap.races.length, 36, 'sem Clash, Duels e All-Star');
  assert(!snap.races.some((r) => /Clash|Duel|All-Star/i.test(r.enName ?? '')));
  assertEquals(snap.races[0].raceId, 'r01-daytona');
  assertEquals(snap.races[0].enName, 'DAYTONA 500');
  const tal = snap.races.find((r) => r.round === 34)!;
  assertEquals([tal.raceId, tal.name, tal.date, tal.status, tal.startsAt], [
    'r34-talladega',
    'Talladega',
    '2026-10-25',
    'upcoming',
    '2026-10-25T18:00:00Z',
  ]);
  assertEquals(snap.races.at(-1)!.name, 'Homestead');
  assertEquals(new Set(snap.races.map((r) => r.raceId)).size, 36);
});

Deno.test('nascar: vencedores e resultados', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  const by = (id: string) => snap.races.find((r) => r.raceId === id)!;
  assertEquals(by('r33-phoenix').winner, 'Tyler Reddick');
  assertEquals(by('r33-phoenix').date, '2026-10-18');
  assertEquals(by('r31-las-vegas').winner, 'Chase Briscoe');
  assertEquals(by('r32-charlotte').winner, 'Chase Briscoe');
  // Corey Heim nao pontua na Cup (fora do feed de pontos): nome vem do resultado.
  assertEquals(by('r22-indianapolis').winner, 'Corey Heim');
  // Grafia do feed de pontos, nao a do resultado ("Suárez").
  assertEquals(by('r13-charlotte').winner, 'Daniel Suarez');
  assertEquals(snap.races.filter((r) => r.status === 'completed').length, 33);
  const phx = snap.results.find((r) => r.raceId === 'r33-phoenix')!;
  assertEquals(phx.rows[0], {
    position: 1,
    driver: 'Tyler Reddick',
    team: '23XI Racing',
    number: '45',
    status: 'Running',
    laps: 312,
    points: 61,
  });
  assert(snap.notes!.some((n) => n.includes('weekend-feed')), 'avisa os resultados que faltaram');
});

Deno.test('nascar: classificacao oficial do feed (sem regra de calculo)', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  const drivers = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(drivers.rows[0], { position: 1, name: 'Kyle Larson', team: 'Hendrick Motorsports', points: 2370 });
  assertEquals(drivers.rows.length, 40);
  assertEquals(drivers.asOfRound, 33);
  assertEquals(adapter.rules, undefined);
});

Deno.test('nascar: nome curto do autodromo', () => {
  assertEquals(shortTrackName('Circuit of The Americas'), 'Austin');
  assertEquals(shortTrackName('Watkins Glen International'), 'Watkins Glen');
  assertEquals(shortTrackName('Michigan International Speedway'), 'Michigan');
  assertEquals(shortTrackName('Talladega Superspeedway'), 'Talladega');
  assertEquals(shortTrackName('San Diego Street Course'), 'San Diego');
});
