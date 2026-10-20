import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';
import { createHttp, fixtureHttp, HttpError, MAX_REDIRECTS, readCapped, redirectTarget, ResponseTooLargeError, SOURCE_HOSTS } from '../_shared/http.ts';

// fetch falso: cada URL tem uma resposta (funcao, para dar Response nova a cada chamada).
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    return Promise.resolve(route ? route() : new Response('nao achou', { status: 404 }));
  };
  return { fn, calls };
}
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const ok = (body: string | Uint8Array<ArrayBuffer>) => () => new Response(body);

Deno.test('http: segue redirecionamento no mesmo host e manda redirect manual', async () => {
  const { fn, calls } = fakeFetch({
    'https://www.indycar.com/a': redirect('/b'),
    'https://www.indycar.com/b': ok('fim'),
  });
  const http = createHttp({ fetch: fn, retryDelayMs: 0 });
  assertEquals(await http.text('https://www.indycar.com/a'), 'fim');
  assertEquals(calls.map((c) => c.url), ['https://www.indycar.com/a', 'https://www.indycar.com/b']);
  assert(calls.every((c) => c.init?.redirect === 'manual'));
});

Deno.test('http: Drive -> drive.usercontent (host das fontes) e permitido', async () => {
  const { fn } = fakeFetch({
    'https://drive.google.com/uc?id=x': redirect('https://drive.usercontent.google.com/download?id=x', 303),
    'https://drive.usercontent.google.com/download?id=x': ok('planilha'),
  });
  assertEquals(await createHttp({ fetch: fn, retryDelayMs: 0 }).text('https://drive.google.com/uc?id=x'), 'planilha');
});

Deno.test('http: redirecionamento para host desconhecido e barrado sem buscar o destino', async () => {
  const { fn, calls } = fakeFetch({
    'https://www.fiaformula2.com/x': redirect('https://169.254.169.254/latest/meta-data'),
  });
  const http = createHttp({ fetch: fn, retryDelayMs: 0 });
  const err = await assertRejects(() => http.text('https://www.fiaformula2.com/x'), HttpError, 'host nao permitido');
  assertEquals((err as HttpError).status, 302);
  assertEquals(calls.length, 1, 'nem tenta de novo nem segue');
});

Deno.test('http: allowedHosts libera um host extra so naquela chamada', async () => {
  const { fn } = fakeFetch({
    'https://cba.org.br/a': redirect('https://cdn.example.org/a'),
    'https://cdn.example.org/a': ok('ok'),
  });
  const http = createHttp({ fetch: fn, retryDelayMs: 0 });
  await assertRejects(() => http.text('https://cba.org.br/a'), HttpError, 'cdn.example.org');
  assertEquals(await http.text('https://cba.org.br/a', undefined, { allowedHosts: ['CDN.example.org'] }), 'ok');
});

Deno.test('http: no maximo 3 redirecionamentos', async () => {
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i <= MAX_REDIRECTS; i++) routes[`https://api.dtm.com/${i}`] = redirect(`/${i + 1}`);
  routes[`https://api.dtm.com/${MAX_REDIRECTS}`] = ok('chegou');
  assertEquals(await createHttp({ fetch: fakeFetch(routes).fn, retryDelayMs: 0 }).text('https://api.dtm.com/0'), 'chegou');
  routes[`https://api.dtm.com/${MAX_REDIRECTS}`] = redirect('/fim');
  routes['https://api.dtm.com/fim'] = ok('longe demais');
  await assertRejects(() => createHttp({ fetch: fakeFetch(routes).fn, retryDelayMs: 0 }).text('https://api.dtm.com/0'), HttpError, 'demais');
});

Deno.test('http: 303 de POST vira GET sem corpo', async () => {
  const { fn, calls } = fakeFetch({
    'https://cba.org.br/form': redirect('/resultado', 303),
    'https://cba.org.br/resultado': ok('ok'),
  });
  const init = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' };
  assertEquals(await createHttp({ fetch: fn, retryDelayMs: 0 }).text('https://cba.org.br/form', init), 'ok');
  assertEquals([calls[1].init?.method, calls[1].init?.body], ['GET', undefined]);
  assertEquals((calls[1].init?.headers as Record<string, string>)['content-type'], undefined);
});

Deno.test('http: redirectTarget barra troca de protocolo, credenciais e Location vazio', () => {
  const o = 'https://www.wrc.com/a';
  assertEquals(redirectTarget(o, '/b?x=1', o), 'https://www.wrc.com/b?x=1');
  assertEquals(redirectTarget(o, 'https://p-p.redbull.com/api', o), 'https://p-p.redbull.com/api');
  assertThrows(() => redirectTarget(o, 'http://www.wrc.com/b', o), Error, 'protocolo');
  assertThrows(() => redirectTarget(o, 'file:///etc/passwd', o), Error, 'protocolo');
  assertThrows(() => redirectTarget(o, 'https://user:pw@www.wrc.com/', o), Error, 'credenciais');
  assertThrows(() => redirectTarget(o, 'https://www.wrc.com:8443/', o), Error, 'host nao permitido');
  assertThrows(() => redirectTarget(o, null, o), Error, 'sem Location');
});

Deno.test('http: corpo acima do limite e abortado (lido aos pedacos ou pelo content-length)', async () => {
  const big = new Uint8Array(64 * 1024);
  const { fn } = fakeFetch({ 'https://cf.nascar.com/big.json': ok(big) });
  const http = createHttp({ fetch: fn, retryDelayMs: 0 });
  await assertRejects(() => http.bytes('https://cf.nascar.com/big.json', undefined, { maxBytes: 1000 }), ResponseTooLargeError, 'limite');
  assertEquals((await http.bytes('https://cf.nascar.com/big.json')).byteLength, big.byteLength, 'padrao de 10 MB');

  // Stream que nunca acaba: tem que parar no limite, nao ler tudo.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1024));
    },
  });
  await assertRejects(() => readCapped(new Response(endless), 10 * 1024, 'x'), ResponseTooLargeError);
  assert(pulled <= 12, `leu ${pulled} pedacos`);

  let read = false;
  const declared = new Response(new ReadableStream({ pull: () => void (read = true) }), { headers: { 'content-length': '999999999' } });
  await assertRejects(() => readCapped(declared, 1000, 'x'), ResponseTooLargeError);
  assertEquals(read, false, 'content-length grande nem comeca a ler');
});

Deno.test('http: fixtureHttp respeita maxBytes', async () => {
  const http = fixtureHttp({ 'https://x.test/a': 'abcdef' });
  await assertRejects(() => http.text('https://x.test/a', undefined, { maxBytes: 3 }), ResponseTooLargeError);
  assertEquals(await http.text('https://x.test/a', undefined, { maxBytes: 6 }), 'abcdef');
});

Deno.test('http: SOURCE_HOSTS cobre todos os hosts dos adaptadores', () => {
  const dir = new URL('../_shared/adapters/', import.meta.url);
  const hosts = new Set<string>();
  for (const f of Deno.readDirSync(dir)) {
    if (!f.name.endsWith('.ts')) continue;
    const src = Deno.readTextFileSync(new URL(f.name, dir));
    for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1].toLowerCase());
  }
  assert(hosts.size >= 10);
  assertEquals([...hosts].filter((h) => !SOURCE_HOSTS.has(h)), []);
});
