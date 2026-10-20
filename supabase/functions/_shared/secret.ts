// Comparacao de segredo (x-sync-secret) em tempo constante: compara os
// SHA-256 dos dois valores (sempre 32 bytes), sem sair no primeiro byte
// diferente. Assim o tempo de resposta nao revela quanto do segredo bateu
// nem o tamanho dele.

const encoder = new TextEncoder();

export async function secretEquals(given: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
