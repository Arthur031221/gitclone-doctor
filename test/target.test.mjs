import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget } from '../lib/target.mjs';

test('accepts owner/repository and strict public GitHub URLs', () => {
  assert.deepEqual(parseTarget('git/git'), {
    owner: 'git',
    repository: 'git',
    name: 'git/git',
    url: 'https://github.com/git/git.git',
  });
  assert.equal(parseTarget('octo-org/tool_2').url, 'https://github.com/octo-org/tool_2.git');
  assert.equal(parseTarget('https://github.com/git/git').name, 'git/git');
  assert.equal(parseTarget('https://github.com/git/git.git').url, 'https://github.com/git/git.git');
});

test('rejects targets that could redirect or carry hidden connection settings', () => {
  const invalid = [
    'https://github.com:443/git/git',
    'https://user@github.com/git/git',
    'https://github.com/git/git?tab=readme',
    'https://github.com/git/git#readme',
    'https://github.com/git/%67it',
    'https://github.com/git/git/extra',
    'https://github.com/git/./repo',
    'https://github.com/git/..\\repo',
    'https://github.com/git//repo',
    'http://github.com/git/git',
    'https://github.example/git/git',
    'git/git/extra',
    'git',
    ' git/git',
    'git/../repo',
    'https://github.com/git/git.git/',
  ];
  for (const value of invalid) assert.throws(() => parseTarget(value), { code: 'invalid_target' }, value);
});

test('rejects non-GitHub URL syntax before Git can see it', () => {
  for (const value of ['ssh://github.com/git/git', 'github.com/git/git', 'https://github.com/git/git%2fother']) {
    assert.throws(() => parseTarget(value), { code: 'invalid_target' });
  }
});
