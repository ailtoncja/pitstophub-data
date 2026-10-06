// Sincroniza o calendario das categorias sem API propria usando a TheSportsDB.
// Roda 1x/dia via GitHub Actions (.github/workflows/sync-categories.yml).
//
// Por que nao eventsround.php: parou de funcionar pra chaves de producao (404
// em toda liga/rodada), e sumiu da documentacao atual da TheSportsDB - parece
// descontinuado, nao uma instabilidade passageira. Em vez disso montamos o
// "esqueleto" da temporada juntando eventsseason.php (temporada inteira, sem
// limite no plano Premium) + eventspastleague.php + eventsnextleague.php, e
// depois detalhamos cada rodada com lookupevent.php (traz strResult/strCity,
// que eventsseason.php nao devolve). Juntar past+next serve de rede de
// seguranca: se a chave cair pro plano gratuito (eventsseason.php limitado a
// 15 eventos), past+next ainda cobrem o que estiver mais perto de hoje.
//
// Env vars necessarias: THESPORTSDB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { apiBaseFor, fetchJson as fetchJsonRaw, getStatus, parseWinner, sleep, REQUEST_DELAY_MS } from './lib/thesportsdb.mjs';

const THESPORTSDB_API_KEY = process.env.THESPORTSDB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!THESPORTSDB_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltam env vars: THESPORTSDB_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const API_BASE = apiBaseFor(THESPORTSDB_API_KEY);
const fetchJson = (path) => fetchJsonRaw(API_BASE, path);
const MAX_ROUNDS = 60; // sanidade: descarta rodadas fora desse intervalo (ex.: eventos de pre-temporada com intRound estranho). NASCAR ja chega a 36 rodadas reais, entao a margem e generosa de proposito.

// id da categoria no app -> id da liga na TheSportsDB
const LEAGUE_IDS = {
  f2: '4486',
  f3: '4487',
  'f1-academy': '5382',
  wec: '4413',
  imsa: '4488',
  dtm: '4438',
  indy: '4373',
  nascar: '4393',
  wrc: '4409',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const rowsByCategory = {};
  const standingsByCategory = {};
  const summary = [];

  for (const [categoryId, leagueId] of Object.entries(LEAGUE_IDS)) {
    try {
      const { rows, standings, standingsRound } = await syncCategory(categoryId, leagueId);
      rowsByCategory[categoryId] = rows;
      if (standings) standingsByCategory[categoryId] = { standings, round: standingsRound };
      summary.push(`${categoryId}: ${rows.length} corridas${standings ? `, classificacao apos rodada ${standingsRound}` : ''}`);
    } catch (error) {
      console.error(`[${categoryId}] falhou:`, error.message);
      summary.push(`${categoryId}: FALHOU (${error.message})`);
    }
  }

  // O calendario tambem e uma "foto" atual: apaga e regrava por categoria.
  // Sem isso, quando a resolucao de temporada troca de ano entre execucoes
  // (ex.: volta a marcar "2025" por um dia), as linhas da temporada errada
  // ficam para sempre (race_id diferente = upsert nunca as sobrescreve).
  //
  // Trava de seguranca: se um dia a chave da TheSportsDB cair pro plano
  // gratuito, eventsseason.php volta a limitar a temporada (a rede de
  // seguranca do past+next so cobre o que estiver perto de hoje, nao a
  // temporada toda). Sem essa trava, um dia de API degradada apagaria
  // corridas antigas boas so porque a resposta daquele dia veio menor.
  const skipped = [];
  let totalRows = 0;
  for (const [categoryId, rows] of Object.entries(rowsByCategory)) {
    if (rows.length === 0) continue;

    const { count: existingCount } = await supabase
      .from('synced_races')
      .select('*', { count: 'exact', head: true })
      .eq('category_id', categoryId);

    if (existingCount != null && existingCount >= 10 && rows.length < existingCount * 0.6) {
      console.warn(`[${categoryId}] API devolveu so ${rows.length} corridas contra ${existingCount} ja salvas - parece degradada. Mantendo dados antigos.`);
      skipped.push(`${categoryId}: MANTIDO dado antigo (API devolveu so ${rows.length}/${existingCount})`);
      continue;
    }

    const { error: deleteError } = await supabase.from('synced_races').delete().eq('category_id', categoryId);
    if (deleteError) {
      console.error(`[${categoryId}] falha ao limpar corridas antigas:`, deleteError.message);
      continue;
    }
    const { error: insertError } = await supabase.from('synced_races').insert(rows);
    if (insertError) {
      if (/starts_at/i.test(insertError.message)) {
        const withoutStartsAt = rows.map(({ starts_at: _startsAt, ...row }) => row);
        const { error: legacyError } = await supabase.from('synced_races').insert(withoutStartsAt);
        if (legacyError) {
          console.error(`[${categoryId}] falha ao gravar corridas:`, legacyError.message);
          continue;
        }
        console.warn(`[${categoryId}] starts_at ainda nao existe no banco -- rode supabase/notifications_schema.sql`);
      } else {
        console.error(`[${categoryId}] falha ao gravar corridas:`, insertError.message);
        continue;
      }
    }
    totalRows += rows.length;
  }

  for (const [categoryId, { standings, round }] of Object.entries(standingsByCategory)) {
    // Mesma trava do calendario: se a API degradada so achou o bloco de
    // classificacao numa rodada mais cedo que a ja salva, isso seria regredir
    // a classificacao (voltar no tempo). Mantem a mais recente que ja temos.
    const { data: existingStandings } = await supabase
      .from('synced_standings')
      .select('as_of_round')
      .eq('category_id', categoryId)
      .limit(1);
    const existingRound = existingStandings?.[0]?.as_of_round;
    if (existingRound != null && round < existingRound) {
      console.warn(`[${categoryId}] classificacao nova e da rodada ${round}, mais antiga que a salva (rodada ${existingRound}) - mantendo a atual.`);
      skipped.push(`${categoryId}: classificacao MANTIDA (nova seria da rodada ${round}, atual e da ${existingRound})`);
      continue;
    }

    // A classificacao e uma "foto" atual, nao historico: apaga e regrava.
    const { error: deleteError } = await supabase.from('synced_standings').delete().eq('category_id', categoryId);
    if (deleteError) {
      console.error(`[${categoryId}] falha ao limpar classificacao antiga:`, deleteError.message);
      continue;
    }
    const standingsRows = standings.map((item) => ({
      category_id: categoryId,
      position: item.position,
      name: item.name,
      team: item.team || null,
      points: item.points,
      as_of_round: round,
      source: 'thesportsdb',
      updated_at: new Date().toISOString(),
    }));
    const { error: insertError } = await supabase.from('synced_standings').insert(standingsRows);
    if (insertError) console.error(`[${categoryId}] falha ao gravar classificacao:`, insertError.message);
  }

  console.log('\n=== Resumo ===');
  summary.forEach((line) => console.log(line));
  if (skipped.length > 0) {
    console.log('\n=== Mantidos (API degradada) ===');
    skipped.forEach((line) => console.log(line));
  }
  console.log(`Total de corridas gravadas: ${totalRows}`);
  console.log(`Categorias com classificacao: ${Object.keys(standingsByCategory).length}/${Object.keys(LEAGUE_IDS).length}`);
}

async function syncCategory(categoryId, leagueId) {
  await sleep(REQUEST_DELAY_MS);
  const past = await fetchJson(`/eventspastleague.php?id=${leagueId}`);
  const season = await resolveCurrentSeason(leagueId, past);

  await sleep(REQUEST_DELAY_MS);
  const seasonData = await fetchJson(`/eventsseason.php?id=${leagueId}&s=${season}`);

  await sleep(REQUEST_DELAY_MS);
  const nextData = await fetchJson(`/eventsnextleague.php?id=${leagueId}`);

  const byRound = groupByRound([
    ...(seasonData?.events ?? []),
    ...(past?.events ?? []),
    ...(nextData?.events ?? []),
  ]);

  const rows = [];
  let latestStandings = null;
  let latestStandingsRound = null;

  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    const main = pickMainEvent(byRound.get(round));
    if (!main) continue;

    // eventsseason.php/eventsnextleague.php nao trazem strResult/strCity;
    // eventspastleague.php so cobre os ultimos 15. Detalha sempre pra ter os
    // dados completos e consistentes, seja qual for a fonte que achou a rodada.
    await sleep(REQUEST_DELAY_MS);
    const detail = await fetchJson(`/lookupevent.php?id=${main.idEvent}`);
    const fullEvent = detail?.events?.[0] ?? main;

    rows.push(buildRow(categoryId, round, fullEvent));

    const standings = parseStandings(fullEvent.strResult);
    if (standings) {
      latestStandings = standings;
      latestStandingsRound = round;
    }
  }

  return {
    rows: applyManualOverrides(categoryId, dropOtherSeasonRows(rows, season)),
    standings: latestStandings,
    standingsRound: latestStandingsRound,
  };
}

// eventspastleague.php as vezes devolve uma rodada de uma temporada anterior
// que calhou de compartilhar numero de rodada com uma da atual (ex.: achamos
// um "3 Hours of Monza" de 2025 junto com o de 2026 na GT World Challenge, e
// um "Las Vegas Race 2" de 2025 na F1 Academy) -- groupByRound/pickMainEvent
// nao tem como saber que sao anos diferentes, entao filtra pelo ano da
// temporada resolvida (resolveCurrentSeason) depois de montar as linhas. So
// filtra quando a temporada e um ano de 4 digitos limpo -- se vier num
// formato diferente (ex. "2025-2026"), nao arrisca descartar tudo por engano.
function dropOtherSeasonRows(rows, season) {
  if (!/^\d{4}$/.test(season)) return rows;
  return rows.filter((row) => row.date?.slice(0, 4) === season);
}

// A TheSportsDB e mantida pela comunidade e as vezes demora dias/semanas pra
// refletir uma mudanca de calendario no meio da temporada (evento cancelado,
// etapa nova substituindo outra). Isso corrige manualmente os casos que ja
// confirmamos em fontes oficiais mas que a API ainda nao atualizou -- e
// auto-neutralizante: assim que a TheSportsDB trouxer o dado certo (rodada
// nova aparecendo, status batendo), a correcao correspondente vira no-op
// sozinha (ver os checks de "ja existe"/"status ja bate" abaixo).
// TheSportsDB as vezes marca a corrida como completed (pela data ja ter
// passado) bem antes de preencher o texto do resultado (strResult) que
// parseWinner() precisa -- o status vem certo, mas o vencedor fica null por
// dias/semanas. fillKnownWinners tapa esse buraco especifico com vencedores
// ja confirmados em fontes oficiais, sem mexer em nada que a API ja preencheu
// sozinha (so entra quando row.winner ainda e null).
function fillKnownWinners(rows, winnersByName) {
  return rows.map((row) => {
    if (row.winner) return row;
    const key = (row.en_name ?? '').replace(/\s+/g, ' ').trim();
    const known = winnersByName[key];
    return known ? { ...row, winner: known } : row;
  });
}

// WEC/IMSA: parseWinner() extrai "equipe #carro" do strResult (e as vezes o
// numero errado — Imola 2026 veio como Toyota #7, mas o vencedor oficial e o
// #8). Sobrescreve mesmo quando a API ja preencheu. Fontes: fiawec.com, imsa.com.
function forceKnownWinners(rows, patterns) {
  return rows.map((row) => {
    if (row.status === 'cancelled') return row;
    const haystack = `${row.en_name ?? ''} ${row.name ?? ''}`;
    for (const { test, winner } of patterns) {
      if (test(haystack)) return { ...row, winner };
    }
    return row;
  });
}

const WEC_OFFICIAL_WINNERS = [
  { test: (s) => /imola/i.test(s), winner: 'Sébastien Buemi' },
  { test: (s) => /spa[- ]francorchamps/i.test(s), winner: 'Robin Frijns' },
  // Nao usar /le mans/ sozinho: casa com "Lone Star Le Mans" (Austin).
  { test: (s) => /le mans/i.test(s) && !/lone star/i.test(s), winner: 'Mike Conway' },
  { test: (s) => /s[aã]o paulo/i.test(s), winner: 'Kevin Magnussen' },
];

const IMSA_OFFICIAL_WINNERS = [
  { test: (s) => /rolex 24/i.test(s) && !/roar/i.test(s), winner: 'Felipe Nasr' },
  { test: (s) => /sebring/i.test(s), winner: 'Felipe Nasr' },
  { test: (s) => /long beach/i.test(s), winner: 'Renger van der Zande' },
  { test: (s) => /laguna seca/i.test(s), winner: 'Tijmen van der Helm' },
  { test: (s) => /detroit/i.test(s), winner: 'Jack Aitken' },
  { test: (s) => /watkins|the glen/i.test(s), winner: 'Jack Aitken' },
  { test: (s) => /canadian tire|mosport|bowmanville/i.test(s), winner: 'Tom Dillmann' },
  { test: (s) => /road america/i.test(s), winner: 'Filipe Albuquerque' },
];

const MANUAL_OVERRIDES = {
  nascar: (rows) =>
    fillKnownWinners(rows, {
      'Cracker Barrel 400': 'Denny Hamlin',
      'FireKeepers Casino 400': 'Denny Hamlin',
      'The Great American Getaway 400': 'Denny Hamlin',
      'Anduril 250': 'Corey Heim',
      'Toyota Save Mart 350': 'Shane van Gisbergen',
      'Eero 400': 'Chase Briscoe',
      'Quaker State 400': 'Ryan Blaney',
      'Window World 450': 'Joey Logano',
      'Brickyard 400': 'Corey Heim',
      'Iowa Corn 350': 'Ty Gibbs',
    }),
  'f1-academy': (rows) =>
    fillKnownWinners(rows, {
      'Shanghai Feature Race': 'Emma Felbermayr',
    }),
  indy: (rows) => {
    // "Freedom 250 GP of Washington, D.C." (Aug 23) foi adicionada ao
    // calendario da IndyCar depois que a temporada 2026 ja tinha sido
    // divulgada -- a TheSportsDB nao tem essa rodada ainda. Fonte:
    // indycar.com (calendario oficial 2026).
    if (rows.some((r) => /washington/i.test(r.en_name ?? ''))) return rows;
    const maxRound = rows.reduce((max, r) => Math.max(max, r.round ?? 0), 0);
    return [
      ...rows,
      {
        category_id: 'indy',
        round: maxRound + 1,
        race_id: 'r-manual-washington-dc',
        name: `Rodada ${maxRound + 1}`,
        en_name: 'Freedom 250 GP of Washington, D.C.',
        location: 'Washington, D.C.',
        en_location: 'Washington, D.C.',
        circuit: 'Streets of Washington',
        date: '2026-08-23',
        status: 'upcoming',
        winner: null,
        external_id: null,
        source: 'manual-override',
        updated_at: new Date().toISOString(),
      },
    ];
  },
  wec: (rows) => {
    // Catar e Bahrein foram cancelados (logistica no Oriente Medio, jul/2026)
    // e substituidos por Barcelona e Monza. A TheSportsDB ainda lista Bahrein
    // como upcoming e nao tem as duas rodadas novas. Fontes: DailySportsCar e
    // Motorsport.com, jul/2026 ("WEC replaces Middle East rounds with new
    // races in Barcelona and Monza").
    const patched = rows.map((row) =>
      /bahrain|qatar|lusail/i.test(row.en_name ?? '') ? { ...row, status: 'cancelled' } : row
    );

    const nowIso = new Date().toISOString();
    const maxRound = patched.reduce((max, r) => Math.max(max, r.round ?? 0), 0);
    const addIfMissing = (matcher, extra) => {
      const matches = (name) =>
        typeof matcher === 'function' ? matcher(name) : matcher.test(name);
      if (patched.some((r) => matches(r.en_name ?? ''))) return;
      patched.push({
        category_id: 'wec',
        round: extra.round,
        name: `Rodada ${extra.round}`,
        status: 'upcoming',
        winner: null,
        external_id: null,
        source: 'manual-override',
        updated_at: nowIso,
        ...extra,
      });
    };
    addIfMissing(/barcelona/i, {
      round: maxRound + 1,
      race_id: 'r-manual-6-hours-of-barcelona',
      en_name: '6 Hours of Barcelona',
      location: 'Barcelona',
      en_location: 'Barcelona',
      circuit: 'Circuit de Barcelona-Catalunya',
      date: '2026-10-18',
    });
    addIfMissing(/monza/i, {
      round: maxRound + 2,
      race_id: 'r-manual-6-hours-of-monza',
      en_name: '6 Hours of Monza',
      location: 'Monza',
      en_location: 'Monza',
      circuit: 'Autodromo Nazionale Monza',
      date: '2026-11-08',
    });
    // A 24h de Le Mans muitas vezes nao entra como rodada da liga WEC na
    // TheSportsDB (evento ACO separado / intRound 0). Sem isso o calendario
    // sincronizado apaga a etapa. Nao casar "Lone Star Le Mans".
    addIfMissing((name) => /le mans/i.test(name) && !/lone star/i.test(name), {
      round: 3,
      race_id: 'r-manual-24-hours-of-le-mans',
      name: '24 Horas de Le Mans',
      en_name: '24 Hours of Le Mans',
      location: 'Le Mans',
      en_location: 'Le Mans',
      circuit: 'Circuit de la Sarthe',
      date: '2026-06-14',
      status: 'completed',
      winner: 'Mike Conway',
    });

    return forceKnownWinners(patched, WEC_OFFICIAL_WINNERS);
  },
  imsa: (rows) => {
    const patched = [...rows];
    // O GP de Long Beach da IMSA as vezes vem com intRound invalido e o
    // groupByRound descarta. Fonte: imsa.com (Acura Grand Prix of Long Beach).
    if (!patched.some((r) => /long beach/i.test(`${r.en_name ?? ''} ${r.name ?? ''}`))) {
      const maxRound = patched.reduce((max, r) => Math.max(max, r.round ?? 0), 0);
      patched.push({
        category_id: 'imsa',
        round: maxRound + 1,
        race_id: 'r-manual-grand-prix-of-long-beach',
        name: 'Grand Prix of Long Beach',
        en_name: 'Grand Prix of Long Beach',
        location: 'Long Beach',
        en_location: 'Long Beach',
        circuit: 'Long Beach Street Circuit',
        date: '2026-04-18',
        status: 'completed',
        winner: 'Renger van der Zande',
        external_id: null,
        source: 'manual-override',
        updated_at: new Date().toISOString(),
      });
    }
    return forceKnownWinners(patched, IMSA_OFFICIAL_WINNERS);
  },
};

function applyManualOverrides(categoryId, rows) {
  const override = MANUAL_OVERRIDES[categoryId];
  return override ? override(rows) : rows;
}

// Junta eventos de varias fontes (dedupe por idEvent) e agrupa por rodada,
// descartando rodadas fora do intervalo valido (ex.: intRound "0" de eventos
// fora do campeonato, tipo o NASCAR All-Star Race, ou valores estranhos tipo
// "500" de eventos de pre-temporada como o Roar Before the Rolex 24 do IMSA).
function groupByRound(events) {
  const merged = new Map();
  for (const event of events) {
    if (event?.idEvent) merged.set(event.idEvent, event);
  }

  const byRound = new Map();
  for (const event of merged.values()) {
    const round = Number(event.intRound);
    if (!Number.isInteger(round) || round < 1 || round > MAX_ROUNDS) continue;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(event);
  }
  return byRound;
}

// lookupleague.php->strCurrentSeason fica desatualizado para varias ligas (viu
// "2025" com a temporada 2026 ja em andamento). O evento passado mais recente
// e um sinal mais confiavel de qual temporada esta rodando agora.
async function resolveCurrentSeason(leagueId, past) {
  const seasonFromPast = past?.events?.[0]?.strSeason;
  if (seasonFromPast) return seasonFromPast;

  await sleep(REQUEST_DELAY_MS);
  const league = await fetchJson(`/lookupleague.php?id=${leagueId}`);
  const season = league?.leagues?.[0]?.strCurrentSeason;
  if (!season) throw new Error('temporada atual nao encontrada');
  return season;
}

function pickMainEvent(events) {
  const feature = events.find((e) => /feature/i.test(e.strEvent));
  if (feature) return feature;

  const race = events
    .filter((e) => /race/i.test(e.strEvent) && !/practice|qualifying|warm[\s-]?up/i.test(e.strEvent))
    .sort((a, b) => (a.strTimestamp ?? a.dateEvent ?? '').localeCompare(b.strTimestamp ?? b.dateEvent ?? ''))
    .at(-1);
  if (race) return race;

  return events
    .filter((e) => !/practice|qualifying|warm[\s-]?up/i.test(e.strEvent))
    .sort((a, b) => (a.strTimestamp ?? a.dateEvent ?? '').localeCompare(b.strTimestamp ?? b.dateEvent ?? ''))
    .at(-1) ?? events.at(-1);
}

function parseStartsAt(event) {
  if (event.strTimestamp) {
    const parsed = new Date(String(event.strTimestamp).replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const time = String(event.strTime ?? '').trim();
  if (event.dateEvent && time && time !== '00:00:00' && time !== '00:00' && time !== '0:00') {
    const normalized = time.length === 5 ? `${time}:00` : time;
    const parsed = new Date(`${event.dateEvent}T${normalized}Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function buildRow(categoryId, round, event) {
  const status = getStatus(event);
  return {
    category_id: categoryId,
    race_id: `r${round}-${slugify(event.strEvent)}`,
    round,
    name: `Rodada ${round}`,
    en_name: event.strEvent,
    location: event.strCity || event.strCountry || null,
    en_location: event.strCity || event.strCountry || null,
    circuit: event.strVenue || null,
    date: event.dateEvent,
    starts_at: parseStartsAt(event),
    status,
    winner: status === 'completed' ? parseWinner(event.strResult) : null,
    external_id: event.idEvent ?? null,
    source: 'thesportsdb',
    updated_at: new Date().toISOString(),
  };
}

// Alguns eventos trazem um bloco extra tipo "Driver Standings after X" ou
// "Current Championship Standings After X" no fim do texto de resultado, com
// linhas "posicao /piloto /equipe /pontos". Nao aparece em toda corrida, entao
// guardamos a classificacao mais recente encontrada (e cumulativa, so cresce).
function parseStandings(strResult) {
  if (!strResult) return null;
  const headingMatch = strResult.match(/.*standings.*/i);
  if (!headingMatch) return null;

  const tail = strResult.slice(strResult.indexOf(headingMatch[0]) + headingMatch[0].length);
  const rows = [];

  for (const rawLine of tail.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const withTeam = line.match(/^(\d{1,2})\s*\/\s*([^/]+?)\s*\/\s*([^/]+?)\s*\/\s*([\d.]+)\s*$/);
    if (withTeam) {
      rows.push({
        position: parseInt(withTeam[1], 10),
        name: withTeam[2].trim(),
        team: withTeam[3].trim(),
        points: parseFloat(withTeam[4]),
      });
      continue;
    }

    // Algumas ligas (ex: WRC) nao trazem equipe na classificacao de pilotos:
    // so "posicao /piloto /pontos".
    const noTeam = line.match(/^(\d{1,2})\s*\/\s*([^/]+?)\s*\/\s*([\d.]+)\s*$/);
    if (noTeam) {
      rows.push({
        position: parseInt(noTeam[1], 10),
        name: noTeam[2].trim(),
        team: null,
        points: parseFloat(noTeam[3]),
      });
    }
  }

  if (rows.length === 0) return null;

  // Categorias multi-classe (ex: WEC com Hypercar/LMGT3) reiniciam a posicao em
  // 1 para cada classe dentro do mesmo bloco de texto. Nesse caso nao existe uma
  // classificacao geral unica, entao preferimos nao gravar nada a misturar
  // posicoes de classes diferentes como se fosse um ranking so.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].position !== i + 1) return null;
  }

  return rows;
}

function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

main().catch((error) => {
  console.error('Sync falhou:', error);
  process.exit(1);
});
