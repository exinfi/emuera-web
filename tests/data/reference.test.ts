import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ref = JSON.parse(fs.readFileSync('reference/builtins.json', 'utf8'));
const names = (k: 'commands' | 'functions' | 'variables') => new Set<string>(ref[k].map((x: any) => x.name));

test('the builtin catalogue lists commands, functions and variables', () => {
  assert.ok(ref.commands.length > 250, `commands: ${ref.commands.length}`);
  assert.ok(ref.functions.length > 200, `functions: ${ref.functions.length}`);
  assert.ok(ref.variables.length > 150, `variables: ${ref.variables.length}`);
});

test('the catalogue knows the everyday names, and entries are unique', () => {
  const c = names('commands');
  for (const n of ['PRINTFORML', 'INPUT', 'BINPUT', 'DATA', 'TIMES', 'REUSELASTLINE', 'TRYCALLFORMF'])
    assert.ok(c.has(n), n);
  assert.ok(names('variables').has('RESULT'));
  assert.equal(c.size, ref.commands.length, 'duplicate command names');
});

test('the save-variable table is well formed', () => {
  const sv = JSON.parse(fs.readFileSync('reference/save-vars.json', 'utf8'));
  assert.ok(typeof sv === 'object' && sv !== null);
  assert.ok(Object.keys(sv).length > 0);
});

test('the known-gaps list is well formed', () => {
  const kg = JSON.parse(fs.readFileSync('reference/known-gaps.json', 'utf8'));
  assert.ok(typeof kg === 'object' && kg !== null);
});
