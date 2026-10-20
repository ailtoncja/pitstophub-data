import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { adapter, fileDate, MAX_DRIVE_ENTRIES, MAX_WORKBOOK_BYTES, parseStages, rules } from '../_shared/adapters/porsche-cup.ts';
import { fixtureHttp, ResponseTooLargeError } from '../_shared/http.ts';
import type { HttpClient } from '../_shared/types.ts';
import { compareStandings, computeStandings } from '../_shared/points.ts';

const dir = new URL('./fixtures/porsche-cup/', import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, dir));
const ROOT = '1dRhvX1ZMZjzjy0ltAfXi6N5s-pBJla5Q';
const SPRINT = '1hWA1UNrSv9aIzECXdfF-eR6ARnBlFUaV';
const ENDURANCE = '1vBcl1jQAICpwMJsVRSUM55VbC0KkFGNK';
const NEWEST = '1RucNDvT9RTE-i2paKDdUaiYgYYmz4pKr';

// Recortes reais de 2026-10-20: secoes #etapas e #resultados da home, as tres
// listagens da pasta do Drive e a planilha PER261005 so com as abas usadas
// (valores, sem macros). A planilha mais antiga (PER260909, pasta Sprint)
// nao esta gravada: se o adaptador tentasse baixa-la, o teste falharia.
function files(home = read('home.html')) {
  return {
    'https://porschecupbrasil.com/': home,
    ...Object.fromEntries(
      [ROOT, SPRINT, ENDURANCE].map((id) => [`https://drive.google.com/embeddedfolderview?id=${id}`, read(`folder_${id}.html`)]),
    ),
    [`https://drive.usercontent.google.com/download?id=${NEWEST}&export=download`]: Deno.readFileSync(
      new URL('PER261005_trimmed.xlsx', dir),
    ),
  };
}
const ctx = (home?: string) => ({ http: fixtureHttp(files(home)), now: new Date('2026-10-20T12:00:00Z'), params: {} });

Deno.test('porsche-cup: calendario do site', () => {
  const stages = parseStages(read('home.html'));
  assertEquals(stages.length, 10);
  assertEquals(stages.find((s) => s.stage === 3), {
    stage: 3,
    date: '2026-11-22',
    type: 'Sprint',
    venue: 'Interlagos',
    categories: ['Challenge', 'Trophy'],
  });
  assertEquals(stages.find((s) => s.stage === 8)!.venue, 'Brasília');
  assertEquals(fileDate('PER261005_V1_IGA_PONTUAÇÃO (1).xlsm'), '2026-10-05');
});

Deno.test('porsche-cup: temporadas pelo calendario', async () => {
  assertEquals(await adapter.listSeasons(ctx()), [2026]);
});

Deno.test('porsche-cup: etapas e vencedores', async () => {
  const snap = await adapter.fetchSnapshot(ctx(), 2026);
  assertEquals(snap.races.length, 10);
  const by = (round: number) => snap.races.find((r) => r.round === round)!;
  assertEquals([by(1).raceId, by(1).date, by(1).winner], ['r01-interlagos', '2026-03-01', 'Marçal Muller / Jeff Giassi']);
  assertEquals(by(4).winner, 'Jeff Giassi / Pietro Fantin');
  assertEquals(by(5).winner, 'Marçal Muller / Lucas Salles');
  assertEquals(by(7).winner, 'Marçal Muller', 'venceu as duas');
  assertEquals([by(6).name, by(6).winner], ['Algarve (Endurance)', 'Marçal Muller / Gaetano di Mauro']);
  assertEquals([by(8).raceId, by(8).date, by(8).winner], ['r08-brasilia', '2026-10-03', 'Matheus Comparatto / Felipe Baptista']);
  // ET 03 (adiada, so Challenge/Trophy) e as etapas de novembro ainda nao correram.
  assertEquals([3, 9, 10].map((r) => by(r).status), ['upcoming', 'upcoming', 'upcoming']);
  assertEquals(by(9).raceId, 'r09-interlagos-f1');
  assert(snap.notes!.some((n) => n.includes('PER261005')), 'usa a planilha mais nova');
});

Deno.test('porsche-cup: Carrera Sprint com descarte confere com a planilha', async () => {
  const snap = await adapter.fetchSnapshot(ctx(), 2026);
  assertEquals(snap.results.length, 10, '5 etapas Sprint x 2 corridas');
  const r1 = snap.results.find((r) => r.raceId === 'r01-interlagos' && r.session === 'race1')!;
  assertEquals(r1.rows[0], { position: 1, driver: 'Marçal Muller', number: '544', status: null, points: 28 });
  const drivers = snap.officialStandings.find((s) => s.group === 'drivers')!;
  assertEquals(drivers.asOfRound, 7);
  assertEquals(drivers.rows.slice(0, 3).map((r) => [r.name, r.points]), [['Marçal Muller', 215], ['Lucas Salles', 160], [
    'Miguel Paludo',
    158,
  ]]);
  const computed = computeStandings(rules[2026], snap.races, snap.results).find((s) => s.group === 'drivers')!;
  const cmp = compareStandings(computed.rows, drivers.rows);
  assert(cmp.matches, cmp.differences.join('; '));
  assert(!snap.notes!.some((n) => n.includes('descartou')), 'descarte da planilha = rules.drops');
});

Deno.test('porsche-cup: outros campeonatos com descartes e desempate da planilha', async () => {
  const snap = await adapter.fetchSnapshot(ctx(), 2026);
  const group = (g: string) => snap.officialStandings.find((s) => s.group === g)!.rows;
  assertEquals(group('challenge').slice(0, 5).map((r) => [r.position, r.name, r.points]), [
    [1, 'Gerson Campos', 159],
    [2, 'Enrico Pedrosa', 150],
    [3, 'Daniel Neumann', 136],
    [4, 'Caio Castro', 110],
    [5, 'Will Cesar', 110],
  ]);
  assertEquals(group('endurance').slice(0, 4).map((r) => r.position), [1, 1, 1, 1]);
  assert(group('trophy').length > 0);
});

Deno.test('porsche-cup: sem link no site usa a pasta conhecida e avisa', async () => {
  const home = read('home.html').replace(/drive\.google\.com\/drive\/u\/1\/folders\/[\w-]+/g, 'example.com');
  const snap = await adapter.fetchSnapshot(ctx(home), 2026);
  assert(snap.notes!.some((n) => n.includes('pasta conhecida')));
  assertEquals(snap.officialStandings.find((s) => s.group === 'drivers')!.rows[0].name, 'Marçal Muller');
});

// Listagem falsa do Drive no formato da pagina embeddedfolderview.
const entry = (id: string, title: string, folder = false) =>
  `<div class="flip-entry" id="entry-${id}" tabindex="0"><div class="flip-entry-info"><a href="https://drive.google.com/${
    folder ? 'drive/folders' : 'file/d'
  }/${id}/view"></a></div><div class="flip-entry-title">${title}</div></div>`;
const homeWith = (folder: string) => read('home.html').replace(/drive\.google\.com\/drive\/u\/1\/folders\/[\w-]+/g, `drive.google.com/drive/folders/${folder}`);
const folderKey = (id: string) => `https://drive.google.com/embeddedfolderview?id=${id}`;
const fileKey = (id: string) => `https://drive.usercontent.google.com/download?id=${id}&export=download`;

Deno.test('porsche-cup: planilha acima de 5 MB nem chega no XLSX.read', async () => {
  const f: Record<string, string | Uint8Array> = { ...files(), [fileKey(NEWEST)]: new Uint8Array(MAX_WORKBOOK_BYTES + 1) };
  const err = await assertRejects(() => adapter.fetchSnapshot({ http: fixtureHttp(f), now: new Date('2026-10-20T12:00:00Z'), params: {} }, 2026));
  assert(err instanceof ResponseTooLargeError);
});

Deno.test('porsche-cup: busca no Drive para depois de 200 entradas', async () => {
  const junk = Array.from({ length: MAX_DRIVE_ENTRIES + 50 }, (_, i) => entry(`junk${i}`, `foto${i}.jpg`)).join('');
  const sheet = entry(NEWEST, 'PER261005_V1_IGA_PONTUACAO.xlsm');
  const run = (listing: string) => {
    const f = { ...files(homeWith('BIG')), [folderKey('BIG')]: listing };
    return adapter.fetchSnapshot({ http: fixtureHttp(f), now: new Date('2026-10-20T12:00:00Z'), params: {} }, 2026);
  };
  const late = await run(junk + sheet);
  assert(late.notes!.some((n) => n.includes(`mais de ${MAX_DRIVE_ENTRIES} entradas`)));
  assert(late.notes!.some((n) => n.includes('Nenhuma planilha')), 'planilha depois do limite e ignorada');
  const early = await run(sheet + junk);
  assertEquals(early.officialStandings.find((s) => s.group === 'drivers')!.rows[0].name, 'Marçal Muller');
});

Deno.test('porsche-cup: no maximo 4 pastas do Drive abertas ao mesmo tempo', async () => {
  const subs = Array.from({ length: 12 }, (_, i) => `sub${i}`);
  const f: Record<string, string | Uint8Array> = {
    ...files(homeWith('ROOT')),
    [folderKey('ROOT')]: subs.map((id) => entry(id, id, true)).join('') + entry(NEWEST, 'PER261005_V1_IGA_PONTUACAO.xlsm'),
    ...Object.fromEntries(subs.map((id) => [folderKey(id), ''])),
  };
  const base = fixtureHttp(f);
  let inFlight = 0;
  let peak = 0;
  const http: HttpClient = {
    ...base,
    text: async (url, init, opts) => {
      if (!url.includes('embeddedfolderview')) return base.text(url, init, opts);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return base.text(url, init, opts);
    },
  };
  await adapter.fetchSnapshot({ http, now: new Date('2026-10-20T12:00:00Z'), params: {} }, 2026);
  assertEquals(peak, 4);
});
