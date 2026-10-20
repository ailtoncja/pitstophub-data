import { assert, assertEquals } from 'jsr:@std/assert@1';
import { adapter, parseForm } from '../_shared/adapters/nascar-brasil.ts';
import { pickDefaultRules } from '../_shared/engine.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';

const dir = new URL('./fixtures/nascar-brasil/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const S = 'https://cba.org.br/campeonato/classificacao/330/50/nascar-brasil-sprint-nbsp-race';

// Recortes reais da CBA de 2026-10-20 (temporada 2026, subcategoria "Nascar Brasil",
// 27 pilotos em 3 paginas). O fixtureHttp ignora o corpo do POST.
const http = fixtureHttp({
  [S]: read('standings_2026_0.html'),
  [`${S}/10`]: read('standings_2026_10.html'),
  [`${S}/20`]: read('standings_2026_20.html'),
  'https://cba.org.br/campeonato/calendario/330/531/nascar-brasil-sprint-nbsp-race': read('calendar_2026.html'),
});
const ctx = { http, now: new Date('2026-10-20T12:00:00Z'), params: {} };

Deno.test('nascar-brasil: filtros do formulario da CBA', async () => {
  assertEquals(parseForm(read('standings_2026_0.html')), {
    years: [2026, 2025, 2024, 2023],
    selectedYear: 2026,
    idClass: '400',
    idSub: '531',
  });
  assertEquals(await adapter.listSeasons(ctx), [2025, 2026]);
});

Deno.test('nascar-brasil: calendario de 9 etapas e vencedores pelos 25 pontos', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  assertEquals(snap.races.map((r) => [r.raceId, r.date, r.status]), [
    ['r01-santa-cruz', '2026-04-12', 'completed'],
    ['r02-cascavel', '2026-05-03', 'completed'],
    ['r03-interlagos', '2026-05-31', 'completed'],
    ['r04-velocitta', '2026-06-28', 'completed'],
    ['r05-cuiaba', '2026-08-02', 'completed'],
    ['r06-londrina', '2026-08-23', 'completed'],
    ['r07-curvelo', '2026-09-20', 'completed'],
    ['r08-chapeco', '2026-11-01', 'upcoming'],
    ['r09-brasilia', '2026-11-29', 'upcoming'],
  ]);
  const by = (id: string) => snap.races.find((r) => r.raceId === id)!;
  assertEquals(by('r07-curvelo').winner, 'Thiago Camilo / Tatiana Calderon');
  assertEquals(by('r06-londrina').winner, 'Thiago Camilo / Gabriel Casagrande');
  assertEquals(by('r04-velocitta').winner, 'Vitor Genz / Galid Osman');
  assertEquals(by('r03-interlagos').winner, 'Nicolas Leite Rebelo', 'venceu as duas');
  assertEquals(by('r04-velocitta').name, 'Velocittá');
  const r1 = snap.results.find((r) => r.raceId === 'r07-curvelo' && r.session === 'race1')!;
  assertEquals(r1.rows[0], { position: 1, driver: 'Thiago Camilo', status: null, points: 25 });
  assert(snap.results.some((r) => r.raceId === 'r07-curvelo' && r.session === 'race2'));
});

Deno.test('nascar-brasil: soma de provas + extras bate com a classificacao oficial', async () => {
  const snap = await adapter.fetchSnapshot(ctx, 2026);
  const official = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(official.rows.length, 27);
  assertEquals(official.rows.slice(0, 2), [{ position: 1, name: 'Thiago Camilo', points: 226 }, {
    position: 2,
    name: 'Arthur Gama',
    points: 225,
  }]);
  assertEquals(official.asOfRound, 7);
  const { rules } = pickDefaultRules(adapter, 2026);
  const computed = computeStandings(rules!, snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(computed.rows, official.rows);
  assert(cmp.matches, cmp.differences.join('; '));
  // Todos os 27, nao so o top 10.
  for (const row of official.rows) assertEquals(computed.rows.find((r) => r.name === row.name)?.points, row.points, row.name);
});

Deno.test('nascar-brasil: descarte publicado entra no calculo', async () => {
  // Simula o descarte do fim de temporada no lider: -10 no total.
  const page = read('standings_2026_0.html')
    .replace("<span class='desc'> -</span>", "<span class='desc'> -10.0</span>")
    .replace("<span class='final'>226</span>", "<span class='final'>216</span>");
  const local = fixtureHttp({
    [S]: page,
    [`${S}/10`]: read('standings_2026_10.html'),
    [`${S}/20`]: read('standings_2026_20.html'),
    'https://cba.org.br/campeonato/calendario/330/531/nascar-brasil-sprint-nbsp-race': read('calendar_2026.html'),
  });
  const snap = await adapter.fetchSnapshot({ ...ctx, http: local }, 2026);
  const computed = computeStandings(pickDefaultRules(adapter, 2026).rules!, snap.races, snap.results).find((s) => s.group === 'drivers')!;
  assertEquals(computed.rows.find((r) => r.name === 'Thiago Camilo')!.points, 216);
  assert(compareStandings(computed.rows, snap.officialStandings[0].rows).matches);
});
