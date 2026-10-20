import { assertEquals } from 'jsr:@std/assert@1';
import { secretEquals } from '../_shared/secret.ts';

Deno.test('secret: compara pelo conteudo, inclusive tamanhos diferentes e unicode', async () => {
  const s = 'um-segredo-bem-longo-e-aleatorio-0123456789';
  assertEquals(await secretEquals(s, s), true);
  assertEquals(await secretEquals(`${s}`.slice(0), s), true);
  assertEquals(await secretEquals(s.slice(0, -1), s), false, 'prefixo');
  assertEquals(await secretEquals(`${s}x`, s), false, 'maior');
  assertEquals(await secretEquals(s.replace(/.$/, 'X'), s), false, 'ultimo caractere');
  assertEquals(await secretEquals('çã€', 'çã€'), true);
  assertEquals(await secretEquals('ca€', 'çã€'), false);
});

Deno.test('secret: ausente ou vazio nunca confere', async () => {
  assertEquals(await secretEquals(null, 'abc'), false);
  assertEquals(await secretEquals(undefined, 'abc'), false);
  assertEquals(await secretEquals('', 'abc'), false);
  assertEquals(await secretEquals('', ''), false, 'segredo nao configurado');
  assertEquals(await secretEquals('abc', null), false);
});
