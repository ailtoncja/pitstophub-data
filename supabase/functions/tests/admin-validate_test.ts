import { assert, assertEquals } from 'jsr:@std/assert@1';
import { isValidDate, MAX_NAME, MAX_NOTE, tokenAal, validateOverride } from '../_shared/admin-validate.ts';

const CATS = ['nascar', 'f2'];
const base = { category: 'nascar', season: 2026, race_id: 'r07-curvelo' };
const err = (body: unknown) => {
  const r = validateOverride(body, CATS);
  return r.ok ? null : r.error;
};

Deno.test('admin: vencedor nao vazio, ate 120 caracteres, sem espacos nas pontas', () => {
  const r = validateOverride({ ...base, kind: 'winner', value: '  Kyle Larson ', note: 'conferido' }, CATS);
  assertEquals(r, {
    ok: true,
    value: { category: 'nascar', season: 2026, race_id: 'r07-curvelo', kind: 'winner', value: 'Kyle Larson', note: 'conferido' },
  });
  assert(err({ ...base, kind: 'winner', value: '   ' }));
  assert(err({ ...base, kind: 'winner', value: 42 }));
  assert(err({ ...base, kind: 'winner', value: 'x'.repeat(MAX_NAME + 1) }));
  assertEquals(err({ ...base, kind: 'winner', value: 'x'.repeat(MAX_NAME) }), null);
});

Deno.test('admin: estado e data', () => {
  for (const v of ['upcoming', 'completed', 'cancelled']) assertEquals(err({ ...base, kind: 'race_status', value: v }), null);
  assert(err({ ...base, kind: 'race_status', value: 'live' }));
  assert(err({ ...base, kind: 'race_status', value: ['completed'] }));
  assertEquals(err({ ...base, kind: 'race_date', value: '2026-02-28' }), null);
  for (const v of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '2026-01-01T00:00:00Z', 20260101]) {
    assert(err({ ...base, kind: 'race_date', value: v }), String(v));
  }
  assertEquals([isValidDate('2028-02-29'), isValidDate('2027-02-29')], [true, false]);
});

Deno.test('admin: pontos de classificacao so com {name, points} validos', () => {
  const r = validateOverride({ category: 'f2', season: 2026, kind: 'standing_points', value: { name: ' Rafael Câmara ', points: 180.5, extra: 'x' } }, CATS);
  assertEquals(r.ok && r.value, { category: 'f2', season: 2026, race_id: null, kind: 'standing_points', value: { name: 'Rafael Câmara', points: 180.5 }, note: null });
  for (const value of [null, 'x', [1], { name: 'A' }, { name: '', points: 1 }, { name: 'A', points: '10' }, { name: 'A', points: NaN }, { name: 'A', points: Infinity }, { name: 'x'.repeat(121), points: 1 }]) {
    assert(err({ category: 'f2', season: 2026, kind: 'standing_points', value }), JSON.stringify(value));
  }
});

Deno.test('admin: categoria, temporada, tipo, race_id e nota', () => {
  assertEquals(err({ ...base, category: 'constructor', kind: 'winner', value: 'A' }), 'categoria invalida');
  assertEquals(err({ ...base, season: '2026', kind: 'winner', value: 'A' }), 'temporada invalida');
  assertEquals(err({ ...base, season: 2026.5, kind: 'winner', value: 'A' }), 'temporada invalida');
  assertEquals(err({ ...base, kind: 'delete_all', value: 'A' }), 'tipo de correcao invalido');
  assertEquals(err({ ...base, race_id: undefined, kind: 'winner', value: 'A' }), 'race_id obrigatorio');
  assertEquals(err({ ...base, race_id: { $ne: 1 }, kind: 'winner', value: 'A' }), 'race_id invalido');
  assertEquals(err({ ...base, kind: 'winner', value: 'A', note: 'n'.repeat(MAX_NOTE + 1) }), `nota com mais de ${MAX_NOTE} caracteres`);
  assertEquals(err({ ...base, kind: 'winner', value: 'A', note: 12 }), `nota com mais de ${MAX_NOTE} caracteres`);
  assertEquals(err({ ...base, kind: 'winner', value: 'A', note: 'n'.repeat(MAX_NOTE) }), null);
  assertEquals(err(null), 'dados invalidos');
  assertEquals(err([]), 'dados invalidos');
});

Deno.test('admin: claim aal do access token', () => {
  const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = (payload: unknown) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.assinatura`;
  assertEquals(tokenAal(token({ sub: 'u', aal: 'aal2', amr: [{ method: 'totp' }] })), 'aal2');
  assertEquals(tokenAal(token({ sub: 'u', aal: 'aal1' })), 'aal1');
  assertEquals(tokenAal(token({ sub: 'u' })), null);
  assertEquals(tokenAal('nao-e-jwt'), null);
  assertEquals(tokenAal('a.%%%.c'), null);
});
