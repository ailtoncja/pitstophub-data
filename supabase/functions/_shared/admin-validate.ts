// Validacao dos dados do painel (funcao admin), sem banco: testavel direto.

export const OVERRIDE_KINDS = ['winner', 'race_status', 'race_date', 'standing_points'] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

export const MAX_NAME = 120;
export const MAX_NOTE = 500;
const MAX_RACE_ID = 120;
const STATUSES = new Set(['upcoming', 'completed', 'cancelled']);

export interface OverrideInput {
  category: string;
  season: number;
  race_id: string | null;
  kind: OverrideKind;
  value: string | { name: string; points: number };
  note: string | null;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Validation<never> => ({ ok: false, error });

/** YYYY-MM-DD que existe no calendario (rejeita 2026-02-30). */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Valor da correcao conforme o tipo; devolve o valor normalizado. */
export function validateOverrideValue(kind: OverrideKind, value: unknown): Validation<OverrideInput['value']> {
  switch (kind) {
    case 'winner': {
      if (typeof value !== 'string' || !value.trim()) return fail('vencedor deve ser um texto nao vazio');
      if (value.trim().length > MAX_NAME) return fail(`vencedor com mais de ${MAX_NAME} caracteres`);
      return { ok: true, value: value.trim() };
    }
    case 'race_status':
      if (typeof value !== 'string' || !STATUSES.has(value)) return fail('estado deve ser upcoming, completed ou cancelled');
      return { ok: true, value };
    case 'race_date':
      if (!isValidDate(value)) return fail('data deve ser YYYY-MM-DD valida');
      return { ok: true, value };
    case 'standing_points': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('pontos devem ser {name, points}');
      const { name, points } = value as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME) {
        return fail(`nome deve ter de 1 a ${MAX_NAME} caracteres`);
      }
      if (typeof points !== 'number' || !Number.isFinite(points)) return fail('pontos devem ser um numero');
      // So os dois campos usados vao para o banco.
      return { ok: true, value: { name: name.trim(), points } };
    }
  }
}

/** Corpo de POST /admin/override. A existencia de race_id e conferida no banco depois. */
export function validateOverride(body: unknown, categoryIds: readonly string[]): Validation<OverrideInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('dados invalidos');
  const { category, season, race_id, kind, value, note } = body as Record<string, unknown>;
  if (typeof category !== 'string' || !categoryIds.includes(category)) return fail('categoria invalida');
  if (typeof season !== 'number' || !Number.isInteger(season) || season < 1900 || season > 2200) return fail('temporada invalida');
  if (typeof kind !== 'string' || !(OVERRIDE_KINDS as readonly string[]).includes(kind)) return fail('tipo de correcao invalido');
  const k = kind as OverrideKind;

  let raceId: string | null = null;
  if (race_id != null && race_id !== '') {
    if (typeof race_id !== 'string' || race_id.length > MAX_RACE_ID) return fail('race_id invalido');
    raceId = race_id;
  }
  if (k !== 'standing_points' && !raceId) return fail('race_id obrigatorio');

  if (note != null && (typeof note !== 'string' || note.length > MAX_NOTE)) return fail(`nota com mais de ${MAX_NOTE} caracteres`);

  const v = validateOverrideValue(k, value);
  if (!v.ok) return v;
  return {
    ok: true,
    value: { category, season, race_id: raceId, kind: k, value: v.value, note: typeof note === 'string' && note ? note : null },
  };
}

/**
 * Claim "aal" do access token (aal1 = so senha, aal2 = com segundo fator).
 * NAO valida assinatura: so usar depois de auth.getUser(token) aceitar o token.
 */
export function tokenAal(accessToken: string): string | null {
  const part = accessToken.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bin = atob(b64);
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return typeof payload?.aal === 'string' ? payload.aal : null;
  } catch {
    return null;
  }
}
