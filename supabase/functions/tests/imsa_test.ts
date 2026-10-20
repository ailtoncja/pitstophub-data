import { assert, assertEquals } from 'jsr:@std/assert@1';
import { imsa, shortName } from '../_shared/adapters/alkamel.ts';
import { fixtureHttp } from '../_shared/http.ts';
import { computeStandings } from '../_shared/points.ts';
import type { HttpClient } from '../_shared/types.ts';

// Recortes reais de 2026-10-20: indice e paginas de evento da Al Kamel (so os
// links da WeatherTech + alguns de outras series), JSONs de corrida e de
// classificacao (campos usados) e grid oficial de cada etapa.
const dir = new URL('./fixtures/imsa/', import.meta.url);
const urls: Record<string, string> = JSON.parse(Deno.readTextFileSync(new URL('urls.json', dir)));
const files = Object.fromEntries(Object.entries(urls).map(([u, f]) => [u, Deno.readTextFileSync(new URL(f, dir))]));
const NOW = new Date('2026-10-20T12:00:00Z');
const ctx = (http: HttpClient = fixtureHttp(files), params: Record<string, unknown> = {}) => ({ http, now: NOW, params });

Deno.test('imsa: temporadas pelo select da Al Kamel', async () => {
  const seasons = await imsa.listSeasons(ctx());
  assertEquals([seasons[0], seasons.at(-1), seasons.length], [2016, 2026, 11]);
});

Deno.test('imsa: 11 etapas da WeatherTech, sem testes nem outras series', async () => {
  const snap = await imsa.fetchSnapshot(ctx(), 2026);
  assertEquals(snap.races.map((r) => r.name), [
    'Daytona', 'Sebring', 'Long Beach', 'Laguna Seca', 'Detroit', 'Watkins Glen', 'Mosport', 'Road America', 'VIR', 'Indianapolis', 'Road Atlanta',
  ]);
  assertEquals(snap.races[0].raceId, 'r01-daytona');
  assertEquals([snap.races[0].enName, snap.races[0].date], ['Rolex 24 at Daytona', '2026-01-24']);
  assertEquals(snap.races[10].enName, '29th Annual Motul Petit Le Mans');
  assert(snap.races.every((r) => r.status === 'completed' && r.official));
  const by = (n: string) => snap.races.find((r) => r.name === n)!.winner!;
  assert(by('Daytona').includes('Felipe Nasr') && by('Sebring').includes('Felipe Nasr'));
  assert(by('Long Beach').includes('Renger van der Zande'));
  assert(by('Laguna Seca').includes('Tijmen van der Helm'));
  assert(by('Detroit').includes('Jack Aitken') && by('Watkins Glen').includes('Jack Aitken'));
  assert(by('Mosport').includes('Tom Dillmann'), 'sem GTP no CTMP: vencedor da LMP2');
  assert(by('Road America').includes('Filipe Albuquerque'));
  assertEquals(by('Road Atlanta'), 'Laurens Vanthoor / Kevin Estre / Matt Campbell');
});

Deno.test('imsa: classificacao calculada confere com o PDF oficial apos Road Atlanta', async () => {
  const snap = await imsa.fetchSnapshot(ctx(), 2026);
  const sets = computeStandings(imsa.rules![2026], snap.races, snap.results);
  const top = (group: string, n: number) => sets.find((s) => s.group === group)!.rows.slice(0, n).map((r) => [r.name, r.points]);
  // "00_Championship Points - Official.pdf" (09-Oct-26): GTP, LMP2, GTD PRO, GTD.
  assertEquals(top('drivers', 6), [
    ['Jack Aitken', 3020], ['Laurin Heinrich', 2859], ['Nick Yelloly', 2723], ['Renger van der Zande', 2723], ['Kevin Estre', 2709], ['Earl Bamber', 2672],
  ]);
  assertEquals(top('class:LMP2', 4), [['Alex Quinn', 2322], ['George Kurtz', 2322], ['Jeremy Clarke', 2302], ['Tom Dillmann', 2302]]);
  assertEquals(top('class:GTDPRO', 4), [['Connor De Phillippi', 3017], ['Neil Verhagen', 3017], ['Andrea Caldarelli', 2979], ['Sandy Mitchell', 2979]]);
  assertEquals(top('class:GTD', 4), [['Philip Ellis', 3078], ['Russell Ward', 3078], ['Patrick Gallagher', 2843], ['Robby Foley', 2843]]);
  assertEquals(snap.officialStandings, []);
});

Deno.test('imsa: classificacao usa o tempo do grid oficial e anula classe sem tempo', async () => {
  const snap = await imsa.fetchSnapshot(ctx(), 2026);
  const q = (raceId: string) => snap.results.find((r) => r.raceId === raceId && r.session === 'qualifying')!;
  // Daytona: o #31 fez a pole, mas o tempo foi anulado (sem tempo no grid oficial): vai para o fim da GTP.
  const gtp = q('r01-daytona').rows.filter((r) => r.class === 'GTP');
  assertEquals(gtp[0].number, '93');
  assertEquals(gtp.at(-1)!.number, '31');
  // Watkins Glen: grid oficial sem nenhum tempo de GTD => ninguem da GTD pontua.
  const wgi = q('r06-watkins-glen').rows;
  assert(wgi.filter((r) => r.class === 'GTD').every((r) => r.position === null));
  assert(wgi.filter((r) => r.class === 'GTP').every((r) => r.position !== null));
  // Corrida: carro que nao largou fica sem posicao.
  const sebring = snap.results.find((r) => r.raceId === 'r02-sebring' && r.session === 'race')!;
  assertEquals(sebring.rows.find((r) => r.number === '79')!.position, null);
});

Deno.test('imsa: eventos encerrados ficam no cache de params', async () => {
  const params: Record<string, unknown> = {};
  await imsa.fetchSnapshot(ctx(fixtureHttp(files), params), 2026);
  const cached = params['events:26_2026'] as Record<string, unknown>;
  assert(cached['02_Daytona International Speedway'], 'Daytona encerrada e oficial');
  const asked: string[] = [];
  const base = fixtureHttp(files);
  const counting: HttpClient = { ...base, text: (u, i) => (asked.push(u), base.text(u, i)) };
  const snap = await imsa.fetchSnapshot(ctx(counting, params), 2026);
  assertEquals(snap.races.length, 11);
  assert(!asked.some((u) => u.includes('evvent=02_Daytona')), 'nao rele a pagina de Daytona');
});

Deno.test('imsa: nomes curtos', () => {
  assertEquals(shortName('15_Canadian Tire Motorsport Park'), 'Mosport');
  assertEquals(shortName('09_Weathertech Raceway Laguna Seca'), 'Laguna Seca');
  assertEquals(shortName('21_Road Atlanta'), 'Road Atlanta');
  assertEquals(shortName('12_Mid-Ohio Sports Car Course'), 'Mid-Ohio');
});

Deno.test('imsa: temporada nova so com testes ainda nao conta', async () => {
  // Como a Al Kamel fica em novembro: 27_2027 aberta so com o Daytona Test.
  const test = files[Object.keys(files).find((u) => u.includes('evvent=00_Daytona'))!]
    .replace(/(<select[^>]*name="season"[^>]*>)/i, '$1<option Value="27_2027" SELECTED>2027')
    .replace(/<option Value="26_2026" SELECTED>/i, '<option Value="26_2026">')
    .replace(/(<select[^>]*name="evvent"[^>]*>)[\s\S]*?<\/select>/i, '$1<option Value="00_Daytona Test" SELECTED>Daytona Test</select>');
  const http = fixtureHttp({ ...files, 'https://imsa.results.alkamelcloud.com/': test });
  const params: Record<string, unknown> = {};
  const seasons = await imsa.listSeasons(ctx(http, params));
  assertEquals(seasons.at(-1), 2026);
  assertEquals(params.confirmedSeasons, undefined);
});
