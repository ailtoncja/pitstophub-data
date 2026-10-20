import { assertEquals } from 'jsr:@std/assert@1';
import { computeStandings } from '../_shared/points.ts';
import type { PointsRules, RaceRecord, RaceResult } from '../_shared/types.ts';

const races: RaceRecord[] = [{ raceId: 'r01-x', round: 1, name: 'X', date: '2026-04-19', status: 'completed' }];

// Uma linha por piloto: os dois pilotos do carro 8 dividem a 1a posicao da classe.
const result: RaceResult = {
  raceId: 'r01-x',
  session: 'race',
  official: true,
  rows: [
    { position: 1, driver: 'Ana', class: 'HYPERCAR', number: '8' },
    { position: 1, driver: 'Bia', class: 'HYPERCAR', number: '8' },
    { position: 2, driver: 'Caio', class: 'HYPERCAR', number: '7' },
    { position: 3, driver: 'Duda', class: 'LMGT3', number: '92' },
    { position: 3, driver: 'Edu', class: 'LMGT3', number: '92' },
    { position: 4, driver: 'Fabi', class: 'LMGT3', number: '33' },
    { position: null, driver: 'Gil', class: 'LMGT3', number: '10' },
  ],
};

const rules: PointsRules = { sessions: { race: [25, 18, 15] }, perClass: true, classGroupNames: { HYPERCAR: 'drivers' } };

Deno.test('classGroupNames renomeia o grupo da classe e mantem o padrao nas outras', () => {
  const sets = computeStandings(rules, races, [result]);
  assertEquals(sets.map((s) => s.group).sort(), ['class:LMGT3', 'drivers']);
  const drivers = sets.find((s) => s.group === 'drivers')!;
  assertEquals(drivers.rows.map((r) => [r.name, r.points]), [['Ana', 25], ['Bia', 25], ['Caio', 18]]);
  const gt3 = sets.find((s) => s.group === 'class:LMGT3')!;
  assertEquals(gt3.rows.map((r) => [r.name, r.points]), [['Duda', 25], ['Edu', 25], ['Fabi', 18]]);
});

Deno.test('sem classGroupNames continua class:<CLASSE>', () => {
  const sets = computeStandings({ sessions: { race: [25, 18] }, perClass: true }, races, [result]);
  assertEquals(sets.map((s) => s.group).sort(), ['class:HYPERCAR', 'class:LMGT3']);
});
