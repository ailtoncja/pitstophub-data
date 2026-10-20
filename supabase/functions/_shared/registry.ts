import type { AdapterWithRules } from './engine.ts';

// Um adaptador por categoria, carregado so quando usado. Para adicionar uma
// categoria: criar adapters/<arquivo>.ts, registrar aqui e inserir a linha em
// category_config (modo dry_run primeiro).
const LOADERS: Record<string, () => Promise<AdapterWithRules>> = {
  nascar: async () => (await import('./adapters/nascar.ts')).adapter,
  'nascar-brasil': async () => (await import('./adapters/nascar-brasil.ts')).adapter,
  indy: async () => (await import('./adapters/indy.ts')).adapter,
  'f1-academy': async () => (await import('./adapters/f1-academy.ts')).adapter,
  f2: async () => (await import('./adapters/fia-formula.ts')).f2,
  f3: async () => (await import('./adapters/fia-formula.ts')).f3,
  wec: async () => (await import('./adapters/alkamel.ts')).wec,
  imsa: async () => (await import('./adapters/alkamel.ts')).imsa,
  dtm: async () => (await import('./adapters/dtm.ts')).adapter,
  wrc: async () => (await import('./adapters/wrc.ts')).adapter,
  'porsche-cup': async () => (await import('./adapters/porsche-cup.ts')).adapter,
};

export const CATEGORY_IDS = Object.keys(LOADERS);

export async function loadAdapter(category: string): Promise<AdapterWithRules | null> {
  const loader = LOADERS[category];
  return loader ? await loader() : null;
}

/** Intervalo minimo entre execucoes, em minutos. */
export function intervalFor(category: string, raceWeekend: boolean): number {
  if (!raceWeekend) return 24 * 60;
  return category === 'nascar' ? 15 : 30;
}
