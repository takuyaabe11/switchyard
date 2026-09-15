// @ts-check
// サブコマンドの振り分け。
import { ask, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { isClaudeSession, sessionId } from '../client/session.mjs';
import { conductorHome } from '../daemon/paths.mjs';
import { probe } from '../run/probe.mjs';
import { runJob } from '../run/run.mjs';
import { parseArgs, UsageError, USAGE } from './args.mjs';
import { renderProbe, renderTop, renderWhy } from './render.mjs';

/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */

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
  const home = conductorHome(env);

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
      return runJob({ argv: command.argv, flags: command.flags, home, env, cwd, out: (l) => stderr(`${l}\n`), connect });
    case 'top': {
      const snap = await status();
      stdout(snap === null ? 'デーモンは動いていない(走行も待ちも無い)\n' : renderTop(snap, now()));
      return 0;
    }
    case 'why': {
      const snap = await status();
      if (snap === null) {
        stdout('デーモンは動いていない\n');
        return 1;
      }
      const r = renderWhy(snap, command.jobId, now());
      stdout(r.text);
      return r.found ? 0 : 1;
    }
    case 'ack': {
      const own = sessionId(env);
      if (command.session !== null && command.session !== own && isClaudeSession(env)) {
        stderr('他のセッションのジョブは、Claude のセッションからは確認済みにできない(人の端末から実行する)\n');
        return 2;
      }
      const session = command.session ?? own;
      try {
        const conn = await connect({ home, env, autoStart: false });
        await ask(conn, { t: 'ack', session, jobId: command.jobId }, (x) => x.t === 'ok');
      } catch (e) {
        if (!(e instanceof DaemonUnavailableError)) throw e;
        stderr('デーモンは動いていない\n');
        return 1;
      }
      stdout(`確認済みにした: ${command.jobId}(セッション ${session})\n`);
      return 0;
    }
    case 'probe': {
      try {
        stdout(renderProbe(await probe({ argv: command.argv, seconds: command.seconds, cwd, env })));
        return 0;
      } catch (e) {
        stderr(`[conductor] probe に失敗: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
    }
  }
}
