// @ts-check
// サブコマンドの振り分け。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ask, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { isClaudeSession, sessionId } from '../client/session.mjs';
import { repoRoot } from '../config/context.mjs';
import { loadProfiles, loadProfilesFile } from '../config/profiles.mjs';
import { stopDaemon } from '../daemon/control.mjs';
import { switchyardHome, pathsOf } from '../daemon/paths.mjs';
import { readJournal } from '../daemon/store.mjs';
import { formatReport, replay } from '../replay/replay.mjs';
import { foregroundCalls, formatInit, merged, suggest, writeConfig } from '../init/init.mjs';
import { formatReport as formatSummary, summarize } from '../report/report.mjs';
import { formatObserved, summarizeObserved } from '../report/observe.mjs';
import { cleanUp, formatUninstall } from './uninstall.mjs';
import { PLUGIN_ROOT } from '../hooks/session.mjs';
import { probe } from '../run/probe.mjs';
import { runJob } from '../run/run.mjs';
import { parseArgs, UsageError, USAGE } from './args.mjs';
import { renderProbe, renderTop, renderWhy } from './render.mjs';
import { t } from '../i18n.mjs';

/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */
/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */

/**
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   stdout?: (s: string) => void,
 *   stderr?: (s: string) => void,
 *   connect?: typeof connectDaemon,
 *   now?: () => number
 * }} CliOptions
 */

/** @param {string[]} args @param {CliOptions} [opts] @returns {Promise<number>} 終了コード */
export async function cli(args, opts = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
    connect = connectDaemon,
    now = Date.now,
  } = opts;
  const home = switchyardHome(env);

  /** @type {import('./args.mjs').Command} */
  let command;
  try {
    command = parseArgs(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(`${e.message}\n${USAGE}\n`);
    return 2;
  }

  /** @returns {Promise<Snapshot | null>} デーモンが居なければ null */
  const status = async () => {
    try {
      const conn = await connect({ home, env, autoStart: false });
      const m = await ask(conn, { t: 'status' }, (x) => x.t === 'status');
      return /** @type {Snapshot} */ (m.snapshot);
    } catch (e) {
      if (e instanceof DaemonUnavailableError) return null;
      throw e;
    }
  };

  switch (command.cmd) {
    case 'help':
      stdout(`${USAGE}\n`);
      return 0;
    case 'run':
      try {
        return await runJob({ argv: command.argv, flags: command.flags, home, env, cwd, out: (l) => stderr(`${l}\n`), connect });
      } catch (e) {
        // profile を解決して初めて分かる使い方の誤り(鍵の無い鍵だけのジョブなど)
        if (!(e instanceof UsageError)) throw e;
        stderr(`${e.message}\n${USAGE}\n`);
        return 2;
      }
    case 'top': {
      const snap = await status();
      stdout(snap === null ? t('デーモンは動いていない(走行も待ちも無い)\n', 'the daemon is not running (nothing running or waiting)\n') : renderTop(snap, now()));
      return 0;
    }
    case 'stop': {
      // 走っているものがあれば、何を落とすのかを先に出す(包みは死なず、次のデーモンへ resume で戻る)
      const snap = await status();
      if (snap !== null && (snap.leases.length > 0 || snap.waiting.length > 0)) {
        stdout(
          t(
            `走行 ${snap.leases.length} 本・待ち ${snap.waiting.length} 本を抱えたまま止める(包みは走り続け、次のデーモンにリースを取り戻す)\n`,
            `stopping with ${snap.leases.length} running and ${snap.waiting.length} waiting (the wrappers keep running and reclaim their leases from the next daemon)\n`,
          ),
        );
      }
      const r = await stopDaemon({ home });
      stdout(`${r.reason}\n`);
      return r.stopped || r.pid === null ? 0 : 1;
    }
    case 'uninstall': {
      // plugin を外す前の後片付け: デーモンを止め、環境ファイルの shims の行と記録を消す
      /** @type {string} */
      let daemon;
      if (command.dryRun) daemon = t('走っていれば止める', 'stop it if it is running');
      else daemon = (await stopDaemon({ home })).reason;
      const r = cleanUp({ home, env, ownShims: join(PLUGIN_ROOT, 'shims'), keepLogs: command.keepLogs, dryRun: command.dryRun });
      stdout(formatUninstall(r, { home, daemon, keepLogs: command.keepLogs, dryRun: command.dryRun }));
      return 0;
    }
    case 'restart': {
      const r = await stopDaemon({ home });
      if (!r.stopped && r.pid !== null) {
        stderr(`${r.reason}\n`);
        return 1;
      }
      stdout(t(`${r.stopped ? r.reason : 'デーモンは動いていなかった'}。新しいデーモンを起動する\n`, `${r.stopped ? r.reason : 'the daemon was not running'}; starting a new one\n`));
      try {
        const conn = await connect({ home, env });
        const m = await ask(conn, { t: 'status' }, (x) => x.t === 'status');
        const snap = /** @type {Snapshot} */ (m.snapshot);
        stdout(t(`起動した(版 ${snap.version ?? '不明'})\n`, `started (version ${snap.version ?? 'unknown'})\n`));
        return 0;
      } catch (e) {
        stderr(t(`新しいデーモンを起動できない: ${e instanceof Error ? e.message : String(e)}\n`, `cannot start a new daemon: ${e instanceof Error ? e.message : String(e)}\n`));
        return 1;
      }
    }
    case 'why': {
      const snap = await status();
      if (snap === null) {
        stdout(t('デーモンは動いていない\n', 'the daemon is not running\n'));
        return 1;
      }
      const r = renderWhy(snap, command.jobId, now());
      stdout(r.text);
      return r.found ? 0 : 1;
    }
    case 'ack': {
      const own = sessionId(env);
      if (command.session !== null && command.session !== own && isClaudeSession(env)) {
        stderr(t('他のセッションのジョブは、Claude のセッションからは確認済みにできない(人の端末から実行する)\n', "a Claude session cannot ack another session's job (run it from your own terminal)\n"));
        return 2;
      }
      // Claude のセッションからは自分のセッションのジョブだけ。人の端末からは --session を省けば、ジョブ id でどのセッションのものでも確認済みにする
      // (人の端末のセッションは human:<pid> で、Claude のセッションのジョブとは一致しない)
      const session = command.session ?? (isClaudeSession(env) ? own : null);
      /** @type {string} */
      let acked;
      try {
        const conn = await connect({ home, env, autoStart: false });
        const m = await ask(conn, { t: 'ack', jobId: command.jobId, ...(session === null ? {} : { session }) }, (x) => x.t === 'ok');
        acked = typeof m.session === 'string' ? m.session : String(session);
      } catch (e) {
        if (e instanceof DaemonUnavailableError) {
          stderr(t('デーモンは動いていない\n', 'the daemon is not running\n'));
          return 1;
        }
        stderr(t(`確認済みにできない: ${e instanceof Error ? e.message : String(e)}\n`, `cannot ack: ${e instanceof Error ? e.message : String(e)}\n`));
        return 1;
      }
      stdout(t(`確認済みにした: ${command.jobId}(セッション ${acked})\n`, `acked: ${command.jobId} (session ${acked})\n`));
      return 0;
    }
    case 'replay': {
      // 過去のセッション記録を、PreToolUse と shim の分類器で空回しする。記録は読むだけで、デーモンは要らない
      const dir = command.dir ?? join(env.HOME ?? homedir(), '.claude', 'projects');
      if (!existsSync(dir)) {
        stderr(t(`記録の置き場所が無い: ${dir}\n`, `no session logs at: ${dir}\n`));
        return 1;
      }
      /** @type {(cwd: string) => NamedProfile[]} */
      let profilesFor;
      if (command.config !== null) {
        const file = resolve(cwd, command.config);
        const loaded = existsSync(file) ? loadProfilesFile(file) : { profiles: [], error: t('ファイルが無い', 'no such file') };
        if (loaded.error !== null) {
          stderr(t(`--config の設定を読めない: ${file}: ${loaded.error}\n`, `cannot read --config: ${file}: ${loaded.error}\n`));
          return 2;
        }
        profilesFor = () => loaded.profiles;
      } else {
        // 記録の cwd ごとに、その repo の switchyard.json と既定表(git を叩くので cwd ごとに 1 回)
        /** @type {Map<string, NamedProfile[]>} */
        const byCwd = new Map();
        profilesFor = (c) => {
          let p = byCwd.get(c);
          if (p === undefined) {
            p = loadProfiles(repoRoot(c)).profiles;
            byCwd.set(c, p);
          }
          return p;
        };
      }
      const since = command.sinceDays === null ? null : now() - command.sinceDays * 86_400_000;
      const report = await replay({ dir, cwdPrefix: command.cwdPrefix, since, profilesFor, examples: command.examples, git: env.SWITCHYARD_GIT === '1' });
      stdout(formatReport(report, { cwdPrefix: command.cwdPrefix, sinceDays: command.sinceDays, examples: command.examples }));
      return 0;
    }
    case 'report': {
      // 記録(events.jsonl と hooks.jsonl)を読むだけ。デーモンが動いていなくても出る
      const p = pathsOf(home);
      const since = command.sinceDays === null ? null : now() - command.sinceDays * 86_400_000;
      // 回した 1 世代前も数に入れる(switchyard report が回転の前後で飛ばない)
      const s = summarize({ events: readJournal(p.events).records, hooks: readJournal(p.hooks).records, repoPrefix: command.repoPrefix, since });
      stdout(formatSummary(s, { repoPrefix: command.repoPrefix, sinceDays: command.sinceDays }));
      // 観察だけのモードの記録があれば、入れていれば何が起きたかも出す
      const observed = readJournal(p.observed).records;
      if (observed.length > 0) stdout(formatObserved(summarizeObserved({ observed, hooks: readJournal(p.hooks).records, repoPrefix: command.repoPrefix, since })));
      return 0;
    }
    case 'init': {
      // 過去のセッション記録から、この repo の profile を提案する。記録は読むだけで、--write のときだけ switchyard.json に書き足す
      const repo = repoRoot(cwd);
      const dir = command.dir ?? join(env.HOME ?? homedir(), '.claude', 'projects');
      const since = command.sinceDays === null ? null : now() - command.sinceDays * 86_400_000;
      const calls = await foregroundCalls({ dir, repo, since });
      const suggestions = suggest({ calls, profiles: loadProfiles(repo).profiles, minCount: command.minCount, minMs: command.minSeconds * 1000 });
      const file = join(repo, 'switchyard.json');
      if (command.write && suggestions.length > 0) {
        try {
          writeConfig(file, merged(file, suggestions));
        } catch (e) {
          stderr(t(`${file} を書けない: ${e instanceof Error ? e.message : String(e)}\n`, `cannot write ${file}: ${e instanceof Error ? e.message : String(e)}\n`));
          return 1;
        }
      }
      stdout(formatInit({ repo, suggestions, calls: calls.length, write: command.write && suggestions.length > 0, file }));
      return 0;
    }
    case 'probe': {
      try {
        stdout(renderProbe(await probe({ argv: command.argv, seconds: command.seconds, cwd, env })));
        return 0;
      } catch (e) {
        stderr(t(`[switchyard] probe に失敗: ${e instanceof Error ? e.message : String(e)}\n`, `[switchyard] probe failed: ${e instanceof Error ? e.message : String(e)}\n`));
        return 1;
      }
    }
  }
}
