// @ts-check
// PostToolUseFailure(Bash): 失敗した Bash の呼び出しのうち、コードのせいではないものを Claude に知らせる。1 本のセッションでも起きる。
// - Bash の時間切れ: 切られたコマンドを覚え(次に同じ場所で走るとき、PreToolUse が時間切れを延ばす)、走らせ直せば延びることを伝える
// - ポートが使用中: そのポートを握っているプロセス(pid・コマンド・作業場所・走っている時間)を突き止めて伝える
// 実物の入力(Claude Code 2.1): { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command, timeout? },
//   error: 'Exit code 143\nCommand timed out after 3s', is_interrupt: false, duration_ms }
// 何も言うことが無ければ null(何も書かない)。
import { repoRoot } from '../config/context.mjs';
import { duration } from '../cli/render.mjs';
import { t } from '../i18n.mjs';
import { isOff } from './off.mjs';
import { loggedCommand } from '../redact.mjs';
import { detailOf, holdersOf, PORT_IN_USE, portsFromText } from './ports.mjs';
import { limitsOf, normalized, rememberTimedOut, timedOutAfter } from './timeouts.mjs';

/** Docker がポートを公開しているときに、握っているように見えるプロセスの名前 */
const DOCKER_NAMES = /^(docker-proxy|com\.docker|vpnkit|docker|dockerd|Docker|rootlessport|slirp4netns|gvproxy|wslrelay)/;

/**
 * @typedef {{ holders?: typeof holdersOf, detail?: typeof detailOf, remember?: typeof rememberTimedOut, now?: () => number }} FailureDeps
 * @typedef {{ out: Record<string, unknown> | null, records: Array<Record<string, unknown>> }} FailureResult
 */

/**
 * @param {Record<string, unknown>} input @param {NodeJS.ProcessEnv} env @param {FailureDeps} [deps]
 * @returns {FailureResult}
 */
export function postToolUseFailure(input, env, { holders = holdersOf, detail = detailOf, remember = rememberTimedOut, now = Date.now } = {}) {
  /** @type {FailureResult} */
  const none = { out: null, records: [] };
  if (isOff(env) || input.tool_name !== 'Bash' || input.is_interrupt === true) return none;
  const error = typeof input.error === 'string' ? input.error : '';
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  const command = typeof ti.command === 'string' ? ti.command : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  /** @type {string[]} */
  const lines = [];
  /** @type {Array<Record<string, unknown>>} */
  const records = [];

  const cutAfter = timedOutAfter(error);
  if (cutAfter !== null && command !== '' && env.SWITCHYARD_TIMEOUT_GUARD !== '0') {
    const { max } = limitsOf(ti, env);
    const limitMs = Math.min(cutAfter, max);
    // 秘密らしい値を含むコマンド(記録なら *** に伏せる部分がある)と、コマンドを記録しない設定(SWITCHYARD_LOG_COMMANDS=none)では、
    // コマンドをそのまま覚えない(覚えないと次に延ばせないので、Claude が自分で timeout を渡すよう伝える)
    const storable = loggedCommand(command, env) === command;
    let remembered = false;
    if (storable) {
      try {
        remember(env, { root: repoRoot(cwd), command: normalized(command), exact: command, limitMs, at: now() });
        remembered = true;
      } catch {
        // 覚えられなくても知らせる
      }
    }
    records.push({ decision: 'timeout', limitMs, ...(remembered ? {} : { remembered: false }) });
    if (limitMs < max && !remembered) {
      const next = Math.min(max, limitMs * 2);
      lines.push(
        t(
          `[switchyard] Bash の時間切れ(${duration(limitMs)})で切られた。コードのせいではない。このコマンドは覚えない(秘密らしい値を含む・コマンドを記録しない設定)ので、走らせ直すときは Bash の timeout に ${next} ミリ秒ほどを渡す。自分では終わらないコマンド(watch モード・サーバー)なら、run_in_background で走らせる。`,
          `[switchyard] This was cut off by the Bash time limit (${duration(limitMs)}); it is not a failure of the code. switchyard does not remember this command (it looks like it holds a secret, or command logging is off), so when you run it again pass a Bash timeout of about ${next} ms. If it never ends by itself (watch mode, a server), run it with run_in_background instead.`,
        ),
      );
    } else if (limitMs >= max) {
      lines.push(
        t(
          `[switchyard] Bash の時間切れの上限(${duration(max)})で切られた。これ以上は延ばせない。テストやビルドが長いだけなら run_in_background で走らせる。自分では終わらないコマンド(watch モード・サーバー)も背景で走らせる。`,
          `[switchyard] This hit the Bash time limit's ceiling (${duration(max)}), so it cannot be given longer. If the test or build is just long, run it with run_in_background; do the same for commands that never end by themselves (watch mode, servers).`,
        ),
      );
    } else {
      const next = Math.min(max, limitMs * 2);
      lines.push(
        t(
          `[switchyard] Bash の時間切れ(${duration(limitMs)})で切られた。コードのせいではない。次に同じ場所でこのコマンドを走らせるときは、switchyard が時間切れを ${duration(next)} に延ばす。遅いだけなら、そのまま走らせ直せばよい。自分では終わらないコマンド(watch モード・サーバー)なら、run_in_background で走らせる。`,
          `[switchyard] This was cut off by the Bash time limit (${duration(limitMs)}); it is not a failure of the code. The next time this command runs here, switchyard gives it ${duration(next)}, so if it is just slow, run it again as is. If it never ends by itself (watch mode, a server), run it with run_in_background instead.`,
        ),
      );
    }
  }

  if (PORT_IN_USE.test(error)) {
    const ports = portsFromText(error, command).slice(0, 3);
    if (ports.length === 0) {
      lines.push(
        t(
          '[switchyard] ポートが使用中で起動できなかった。コードのせいではない。番号は出力から読めなかった。前に起動したサーバーの残りが無いか確かめる。',
          '[switchyard] It could not start because a port is already in use; this is not a failure of the code. The port number is not in the output; check for a server left running from earlier.',
        ),
      );
      records.push({ decision: 'port', port: null, holders: 0 });
    }
    for (const p of ports) {
      /** @type {import('./ports.mjs').Holder[]} */
      let hs = [];
      try {
        hs = holders(p).slice(0, 3);
      } catch {
        hs = [];
      }
      records.push({ decision: 'port', port: p, holders: hs.length });
      if (hs.length === 0) {
        lines.push(
          t(
            `[switchyard] ポート ${p} が使用中で起動できなかった。コードのせいではない。握っているプロセスは見つからなかった(他のユーザーのプロセス・コンテナや VM の中・もう終わった)。`,
            `[switchyard] Port ${p} is already in use, so it could not start; this is not a failure of the code. No process holding it could be found (another user's process, inside a container or VM, or already gone).`,
          ),
        );
        continue;
      }
      const described = hs.map((h) => {
        const d = (() => {
          try {
            return detail(h.pid);
          } catch {
            return { command: null, cwd: null, elapsedSec: null };
          }
        })();
        /** @type {string[]} */
        const parts = [];
        const what = d.command ?? h.name;
        if (what !== '') parts.push(what.length > 120 ? `${what.slice(0, 117)}…` : what);
        if (d.elapsedSec !== null) parts.push(t(`${duration(d.elapsedSec * 1000)}前から`, `running for ${duration(d.elapsedSec * 1000)}`));
        if (d.cwd !== null) parts.push(t(`作業場所 ${d.cwd}`, `in ${d.cwd}`));
        return { pid: h.pid, docker: DOCKER_NAMES.test(h.name) || DOCKER_NAMES.test(d.command ?? ''), text: `pid ${h.pid}${parts.length > 0 ? t(`(${parts.join('・')})`, ` (${parts.join(', ')})`) : ''}` };
      });
      const who = described.map((x) => x.text).join(t('、', '; '));
      if (described.every((x) => x.docker)) {
        lines.push(
          t(
            `[switchyard] ポート ${p} が使用中で起動できなかった。コードのせいではない。Docker のコンテナがこのポートを公開している(${who})。docker ps で確かめ、この作業で起動したコンテナなら止めるか、別のポートを使う。`,
            `[switchyard] Port ${p} is already in use, so it could not start; this is not a failure of the code. A Docker container publishes this port (${who}). Check with docker ps; stop the container if this work started it, or use another port.`,
          ),
        );
      } else {
        const pids = described.map((x) => x.pid).join(' ');
        lines.push(
          t(
            `[switchyard] ポート ${p} が使用中で起動できなかった。コードのせいではない。握っているのは ${who}。この作業で前に起動したものの残りなら止める(kill ${pids})。そうでなければ別のポートを使う。`,
            `[switchyard] Port ${p} is already in use, so it could not start; this is not a failure of the code. It is held by ${who}. If that is left over from something started earlier in this work, stop it (kill ${pids}); otherwise use another port.`,
          ),
        );
      }
    }
  }
  if (lines.length === 0) return { out: null, records };
  return { out: { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: lines.join('\n') } }, records };
}
