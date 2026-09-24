// @ts-check
// 記録に残すコマンドから秘密を隠す(src/redact.mjs)と、その通し(包みの記録・hook の記録)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathsOf } from '../src/daemon/paths.mjs';
import { runHook } from '../src/hooks/main.mjs';
import { loggedCommand, maskSecrets } from '../src/redact.mjs';
import { buildRequest } from '../src/run/run.mjs';

describe('maskSecrets', () => {
  it('秘密らしい値だけを *** にする', () => {
    const cases = [
      ['STRIPE_SECRET_KEY=sk_live_abcdefghijkl pnpm tsx scripts/backfill.ts', 'STRIPE_SECRET_KEY=*** pnpm tsx scripts/backfill.ts'],
      ['WANDB_API_KEY=abc123 python train.py', 'WANDB_API_KEY=*** python train.py'],
      ['export ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxx && npm test', 'export ANTHROPIC_API_KEY=*** && npm test'],
      ['./gradlew test -Dspring.datasource.password=hunter2 --info', './gradlew test -Dspring.datasource.password=*** --info'],
      ['mysql -uroot -pS3cret db', 'mysql -uroot -p*** db'],
      ['docker login --password hunter2 --username bob', 'docker login --password *** --username bob'],
      ['curl --token=zzz https://x', 'curl --token=*** https://x'],
      ['curl -H "Authorization: Bearer abc.def" https://x', 'curl -H "Authorization: ***" https://x'],
      ['git clone https://user:tok123@github.com/a/b', 'git clone https://user:***@github.com/a/b'],
      ['echo ghp_abcdefghijklmnopqrstuvwxyz0123', 'echo ***'],
      ['aws s3 ls # AKIAABCDEFGHIJKLMNOP', 'aws s3 ls # ***'],
    ];
    for (const [input, want] of cases) assert.equal(maskSecrets(input), want, input);
  });

  it('秘密でない普通のコマンドは変えない', () => {
    for (const c of ['npm test', 'NODE_ENV=test npm test', 'pytest -p no:cacheprovider -n auto', 'mkdir -p build && make', 'mysql -uroot -p db', 'cargo test --release', 'git commit -m "fix token parsing"']) {
      assert.equal(maskSecrets(c), c, c);
    }
  });

  it('SWITCHYARD_LOG_COMMANDS: masked(既定)・full・none', () => {
    const c = 'API_TOKEN=abc /usr/bin/npm test';
    assert.equal(loggedCommand(c, {}), 'API_TOKEN=*** /usr/bin/npm test');
    assert.equal(loggedCommand(c, { SWITCHYARD_LOG_COMMANDS: 'full' }), c);
    assert.equal(loggedCommand('/usr/bin/npm test --x', { SWITCHYARD_LOG_COMMANDS: 'none' }), 'npm ***');
  });
});

describe('記録に秘密を残さない', () => {
  it('包みの要求のコマンドと、分類されない走行の profile の名前は隠す', () => {
    const { job } = buildRequest({ argv: ['node', 'scripts/x.js', '--api-key=sekrit'], flags: {}, env: {}, cwd: tmpdir() });
    assert.equal(job.cmd, 'node scripts/x.js --api-key=***');
    const { job: j2 } = buildRequest({ argv: ['curl', '--token=sekrit'], flags: {}, env: {}, cwd: tmpdir() });
    assert.equal(j2.profile, 'cmd:curl --token=***');
  });

  it('hook の記録のコマンドも隠す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'credact-'));
    await runHook('pre-tool-use', JSON.stringify({ session_id: 's', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'DB_PASSWORD=hunter2 /usr/local/bin/npm test' } }), {
      env: { SWITCHYARD_HOME: home },
      profilesFor: () => [{ name: 'unit', profile: { match: ['npm test*'], class: 'batch' } }],
      write: () => {},
    });
    const row = JSON.parse(readFileSync(pathsOf(home).hooks, 'utf8').trim());
    assert.equal(row.cmd, 'DB_PASSWORD=*** /usr/local/bin/npm test');
  });
});
