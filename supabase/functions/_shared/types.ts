// Tipos compartilhados do motor de sincronizacao.
//
// Cada categoria tem um adaptador (adapters/*.ts) que sabe ler a fonte oficial
// e devolve um Snapshot neutro. O motor (engine.ts) valida, aplica correcoes
// manuais, calcula/compara a classificacao e so entao grava no banco.

export type RaceStatus = 'upcoming' | 'completed' | 'cancelled';

export interface RaceRecord {
  /** Identificador estavel dentro da temporada (ex.: "r07-curvelo"). */
  raceId: string;
  round: number;
  /** Nome exibido em portugues (o app usa "Rodada N" quando nao ha nome melhor). */
  name: string;
  enName?: string | null;
  location?: string | null;
  enLocation?: string | null;
  circuit?: string | null;
  /** Data local da corrida, YYYY-MM-DD. */
  date: string;
  /** Instante ISO (UTC) da largada, quando a fonte informa. */
  startsAt?: string | null;
  status: RaceStatus;
  winner?: string | null;
  /** false = resultado provisorio (pode mudar por punicao). */
  official?: boolean;
  externalId?: string | null;
  sourceUrl?: string | null;
}

export interface ResultRow {
  /** null = nao classificado (abandono, DQ...). */
  position: number | null;
  driver: string;
  team?: string | null;
  number?: string | null;
  /** Classe em categorias multiclasse (WEC, IMSA, GTWC...). */
  class?: string | null;
  status?: string | null;
  laps?: number | null;
  /** Pontos que a propria fonte oficial atribuiu nesta sessao (quando existe). */
  points?: number | null;
}

export interface RaceResult {
  raceId: string;
  /** Sessao que pontua: "race", "sprint", "feature", "race1", "race2", "qualifying"... */
  session: string;
  official: boolean;
  rows: ResultRow[];
}

export interface StandingRow {
  position: number;
  name: string;
  team?: string | null;
  points: number;
}

export interface StandingsSet {
  /**
   * "drivers" e a lista que o app mostra hoje (vai para synced_standings).
   * Outros grupos ("teams", "class:GTP", "class:LMGT3"...) vao para standings_detail.
   */
  group: string;
  rows: StandingRow[];
  asOfRound?: number | null;
}

export interface Snapshot {
  season: number;
  races: RaceRecord[];
  results: RaceResult[];
  /** Classificacao publicada pela fonte oficial (para conferencia). */
  officialStandings: StandingsSet[];
  /** Avisos do adaptador (ex.: "PDF da etapa X ainda nao saiu"). */
  notes?: string[];
}

export interface FetchOptions {
  /** Hosts extras para onde um redirecionamento pode ir (alem do host do pedido e das fontes conhecidas). */
  allowedHosts?: string[];
  /** Tamanho maximo da resposta em bytes (padrao 10 MB). */
  maxBytes?: number;
}

export interface HttpClient {
  text(url: string, init?: RequestInit, opts?: FetchOptions): Promise<string>;
  json<T = unknown>(url: string, init?: RequestInit, opts?: FetchOptions): Promise<T>;
  bytes(url: string, init?: RequestInit, opts?: FetchOptions): Promise<Uint8Array>;
}

export interface AdapterContext {
  http: HttpClient;
  now: Date;
  /** Parametros descobertos/salvos em category_config.params (cache entre execucoes). */
  params: Record<string, unknown>;
}

export interface Adapter {
  /** id da categoria no app (ex.: "nascar", "f1-academy", "gtwc-europe"). */
  id: string;
  /** Nome da fonte, para logs e alertas. */
  source: string;
  /**
   * Temporadas que a fonte ja publicou (com calendario). E o que permite a
   * virada de ano sozinha: nada de ano ou ID de temporada fixo no codigo.
   */
  listSeasons(ctx: AdapterContext): Promise<number[]>;
  fetchSnapshot(ctx: AdapterContext, season: number): Promise<Snapshot>;
  /**
   * Horas depois da data da corrida em que o resultado deveria estar na fonte.
   * Passou disso sem vencedor => alerta de atraso. Padrao: 24.
   */
  staleAfterHours?: number;
}

export type SyncMode = 'off' | 'dry_run' | 'live';

export interface PointsRules {
  /** Pontos por posicao, por sessao. Ex.: { race: [25, 18, ...], sprint: [...] }. */
  sessions: Record<string, number[]>;
  /** Fator por corrida (ex.: Le Mans 2x). Chave = raceId ou regex entre barras. */
  multipliers?: Record<string, number>;
  /** Quantos piores resultados descartar (por sessao pontuavel). */
  drops?: number;
  /**
   * Quando true, usa ResultRow.points da fonte (ja inclui bonus) e ignora a
   * tabela. E o caso de IndyCar, DTM, F2/F3 etc.
   */
  useSourcePoints?: boolean;
  /** Pontua por classe (WEC/IMSA). */
  perClass?: boolean;
  /**
   * Com perClass: nome do grupo de cada classe (padrao "class:<CLASSE>").
   * Ex.: { HYPERCAR: 'drivers' } faz a classe principal virar a lista do app.
   */
  classGroupNames?: Record<string, string>;
}

export interface Change {
  entity: 'race' | 'standings' | 'season';
  key: string;
  before: unknown;
  after: unknown;
}

export interface RunReport {
  category: string;
  mode: SyncMode;
  season: number | null;
  ok: boolean;
  wrote: boolean;
  changes: Change[];
  problems: string[];
  warnings: string[];
  asOfRound: number | null;
  durationMs: number;
}
