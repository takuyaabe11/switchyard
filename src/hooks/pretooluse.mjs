// @ts-check
// PreToolUse(Bash)の判定(設計 §9.2)。hook の標準入力の JSON を受け、出力の JSON を返す(何もしないなら null)。
//   - 背景への書き換え: PATH の shim か switchyard run の包みが CPU を持つ走行(batch / measure)を起こす部分があれば、run_in_background だけを true にする。
//     コマンドの文字列は変えないので権限の判定に影響しない。だから判定は広めに取る(bash -c の中・( … )・$( … )・switchyard run の `--` の後ろも見る)
//   - 拒否: shim の語の実行ファイルをパスで直に呼ぶ部分(/usr/local/bin/npm test・/usr/bin/git commit)だけ。本当に shim を迂回する形はこれしか無い。
//     shim の語でないものをパスで呼ぶ形(scripts/probe-run.sh・./node_modules/.bin/vitest)と shim の無い語は、重ければ背景に回すだけ(改善 2)
//   - 分類に渡すのは classifiableCommand の文字列(node -e のコードの中身では分類しない)
import { basename } from 'node:path';
import { parseArgs } from '../cli/args.mjs';
import { repoRoot } from '../config/context.mjs';
import { classifiableCommand, classify, globMatch, loadProfiles } from '../config/profiles.mjs';
import { GIT_LOCK_SUBCOMMANDS, gitSubcommand } from '../shim/decide.mjs';
import { simpleCommands } from './shell.mjs';
import { rightSize, usageKey } from '../core/usage.mjs';
import { t } from '../i18n.mjs';
import { isOff } from './off.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../run/run.mjs').RunFlags} RunFlags */

/** shim を置く語(設計 §9.1)。shims/ の実物と同じ 26 語 */
export const SHIM_WORDS = [
  'npm', 'npx', 'node', 'cargo', 'pytest', 'go', 'make', 'git', 'yarn', 'pnpm', 'bun',
  'python', 'python3', 'uv', 'poetry', 'mvn', 'gradle', 'dotnet', 'bundle', 'rspec', 'deno',
  'xcodebuild', 'bazel', 'bazelisk', 'nx', 'turbo',
];

/**
 * プロジェクトの中の道具の置き場(仮想環境・node_modules/.bin)。ここの実行ファイルをパスで呼ぶのは shim の迂回ではなく、
 * 別の(プロジェクトの)実行ファイルを選んでいる。名前で呼び直すと PATH の別物が走るので拒否しない(重ければ背景へ回すだけ)。
 * @param {string} path @returns {boolean}
 */
const isProjectLocal = (path) => /(^|\/)(\.?venv[^/]*|\.tox|\.nox|node_modules\/\.bin)\//.test(path);

/**
 * Python の仮想環境の中の実行ファイルか。node_modules/.bin と違い、shebang が仮想環境の python を直に指すので、
 * shim を通らない(順番待ちに乗らない)。
 * @param {string} path @returns {boolean}
 */
const isVenvPath = (path) => /(^|\/)(\.?venv[^/]*|\.tox|\.nox)\//.test(path);

/** 仮想環境を有効にする形(source .venv/bin/activate・. venv/bin/activate)。以降の python・pytest は仮想環境の物が shim より先に引かれる */
const isActivate = (/** @type {string} */ head, /** @type {string[]} */ rest) => (head === 'source' || head === '.') && /(^|\/)bin\/activate$/.test(rest[0] ?? '');

/**
 * パスで呼ぶビルドの包み(./gradlew・./mvnw)の重いサブコマンド。shim を置けないので、順番待ちに乗せるには switchyard run で包む。
 * @type {Record<string, string[]>}
 */
const WRAPPER_SCRIPTS = {
  gradlew: ['test', 'build', 'check', 'assemble', 'integrationTest', 'connectedCheck'],
  mvnw: ['test', 'verify', 'package', 'install', 'integration-test'],
};

/** @param {string} base @param {string[]} rest @returns {boolean} */
const isHeavyWrapperScript = (base, rest) => {
  const subs = WRAPPER_SCRIPTS[base];
  return subs !== undefined && rest.some((w) => !w.startsWith('-') && subs.some((sub) => w === sub || w.endsWith(`:${sub}`)));
};

/** `-c 文字列` の文字列をコマンドとして走らせるシェル */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** 後ろにコマンドが続くシェルの予約語 */
const RESERVED = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until']);
/** env の、値の語を取るオプション(GNU と BSD) */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir', '-P', '-S', '--split-string']);

/** shim を素通りさせる環境変数。PATH を差し替えると shim が引かれず、残りの 2 つは shim に「ジョブの中」「鍵は祖先が持つ」と思わせる */
const BYPASS_VARS = ['PATH', 'SWITCHYARD_IN_JOB', 'SWITCHYARD_HELD_LOCKS', 'SWITCHYARD_OFF', 'SWITCHYARD_THINKER'];

/**
 * コマンドの前の代入(VAR=値・env NAME=値・env -i・env -u NAME)のうち、shim を素通りさせるもの。
 * PATH は元の $PATH を後ろに残す形(PATH=/x:$PATH)なら shims が先頭に残るので数えない。
 * @param {string[]} assigns `NAME=値` の語 @param {string[]} unset env -u の名前 @param {boolean} cleared env -i
 * @returns {string[]}
 */
function bypasses(assigns, unset, cleared) {
  /** @type {string[]} */
  const out = cleared ? ['env -i'] : [];
  for (const a of assigns) {
    const name = a.slice(0, a.indexOf('='));
    const value = a.slice(a.indexOf('=') + 1);
    if (!BYPASS_VARS.includes(name)) continue;
    if (name === 'PATH' && /\$\{?PATH\}?/.test(value)) continue;
    out.push(a);
  }
  for (const n of unset) if (n === 'PATH') out.push(`env -u ${n}`);
  return out;
}

/**
 * 単純コマンドの語の列の、先頭の語とそれより後ろの語。
 * VAR=値・予約語(if / then / do など)と、env [-u NAME などのオプション] / timeout [オプション] N / nice [-n N] / time / nohup / command を読み飛ばす。
 * 読み飛ばした代入のうち shim を素通りさせるもの(bypasses)も返す。
 * @param {string[]} words @returns {{ head: string, rest: string[], bypass: string[] }}
 */
function headOf(words) {
  let i = 0;
  /** @type {string[]} */
  const assigns = [];
  /** @type {string[]} */
  const unset = [];
  let cleared = false;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || RESERVED.has(w)) {
      if (!RESERVED.has(w)) assigns.push(w);
      i += 1;
    } else if (w === 'timeout') {
      // timeout [オプション] 時間 コマンド
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += words[i] === '-s' || words[i] === '-k' ? 2 : 1;
      i += 1;
    } else if (w === 'nice') {
      i += 1;
      if (words[i] === '-n') i += 2;
      else if (/^-[0-9]+$/.test(words[i] ?? '')) i += 1;
    } else if (w === 'env') {
      // env [オプション] [NAME=値]... コマンド。-u NAME などは値の語も飛ばす(NAME=値 は上の枝が飛ばす)
      i += 1;
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-i' || words[i] === '-' || words[i] === '--ignore-environment') cleared = true;
        if ((words[i] === '-u' || words[i] === '--unset') && words[i + 1] !== undefined) unset.push(words[i + 1]);
        i += ENV_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
      }
    } else if (w === 'time' || w === 'nohup' || w === 'command') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += 1;
    } else {
      break;
    }
  }
  return { head: words[i] ?? '', rest: words.slice(i + 1), bypass: bypasses(assigns, unset, cleared) };
}

/**
 * 空白で区切った部分の、先頭の語とそれより後ろの語(読み飛ばす語は headOf と同じ)。
 * @param {string} segment @returns {{ head: string, rest: string[] }}
 */
export function headWord(segment) {
  const { head, rest } = headOf(segment.split(' ').filter((w) => w !== ''));
  return { head, rest };
}

/** glob の先頭の字句(先頭の * を除いた最初の語の、ワイルドカードより前) @param {string} glob @returns {string} */
function leadWord(glob) {
  const first = glob.replace(/^\*+/, '').split(' ')[0];
  const cut = first.search(/[*?]/);
  return cut < 0 ? first : first.slice(0, cut);
}

/**
 * sh / bash などの `-c 文字列` の文字列(`-lc` のようにまとめたオプションも見る)。スクリプトのファイルを走らせる形なら null。
 * @param {string[]} rest @returns {string | null}
 */
function shellScript(rest) {
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) return rest[i + 1] ?? null;
    if (/^[-+][A-Za-z]*o$/.test(w)) i += 1;
    else if (!/^[-+]/.test(w)) return null;
  }
  return null;
}

/**
 * switchyard run の部分なら、`run` より後ろの引数。`switchyard` / `switchyard.mjs` をどこから呼んでも、`node …/switchyard.mjs run` でも同じ。
 * @param {string} head @param {string[]} rest @returns {string[] | null}
 */
function switchyardRunArgs(head, rest) {
  const base = basename(head);
  if ((base === 'switchyard' || base === 'switchyard.mjs') && rest[0] === 'run') return rest.slice(1);
  if (base === 'node' && basename(rest[0] ?? '') === 'switchyard.mjs' && rest[1] === 'run') return rest.slice(2);
  return null;
}

/**
 * switchyard run の包みが要求する性格と、`--` の後ろの語。buildRequest と同じ順(--class → --profile → `--` の後ろの分類 → batch)で決める。
 * 引数が読めなければ `--` の後ろだけを見る(背景への判定は広めでよい)。
 * @param {string[]} args @param {NamedProfile[]} profiles @returns {Heavy & { argv: string[] }}
 */
function wrapperOf(args, profiles) {
  /** @type {RunFlags} */
  let flags = {};
  let argv = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
  try {
    const parsed = parseArgs(['run', ...args]);
    if (parsed.cmd === 'run') ({ flags, argv } = parsed);
  } catch {
    // 使い方の誤りで包みは走らないが、`--` の後ろで判定しておく
  }
  const named = flags.profile !== undefined ? (profiles.find((p) => p.name === flags.profile) ?? null) : classify(classifiableCommand(argv), profiles);
  /** @type {Heavy} */
  const need = {
    jobClass: flags.class ?? named?.profile.class ?? 'batch',
    cpusMin: flags.cpus?.min ?? named?.profile.cpus?.min ?? 1,
    locks: [...new Set([...(named?.profile.locks ?? []), ...(flags.locks ?? [])])],
    ...(named === null ? {} : { profile: named.name }),
  };
  return { ...need, argv };
}

/** profile が要求する資源(buildRequest と同じ既定: CPU 1) @param {import('../config/profiles.mjs').Profile} p @returns {Heavy} */
const needOf = (p, /** @type {string} */ name) => ({ jobClass: p.class, cpusMin: p.cpus?.min ?? 1, locks: p.locks ?? [], profile: name });

/**
 * 背景へ回すかを決める関数。既定は「重いものは必ず回す」(switchyard replay の数え方と同じ)。
 * hook の入口は、デーモンの盤面を見て待ちが見込まれるときだけ回す関数を渡す(waitExpected)。
 * @typedef {(heavy: Heavy[]) => boolean} BackgroundPolicy
 */
/** @typedef {{ jobClass: JobClass, cpusMin: number, locks: string[], profile?: string }} Heavy */

/**
 * いまの盤面で、この重い部分が待たされる見込みがあるか。
 * 待ち列がある・計測が走っている・計測を要求するのに CPU を持つ走行がある・鍵が使われている・CPU の空きが足りない、のどれか。
 * 見込みが無ければ前景のまま走らせる(待たないなら背景へ回す理由が無く、回すとエージェントは完了の通知を待つことになる)。
 * repo を渡すと、デーモンが実測で縮める profile(盤面の sized)は縮めた要求で見積もる(right-sizing と同じ計算)。
 * 宣言の空きが足りなくても、重い部分が 1 つで、デーモンが測った実測の空き(盤面の spare)に収まれば、
 * 次の標本(1 秒ごと)で詰め込まれるので待たないとみなす(詰め込みは 1 回に 1 本なので、2 つ以上なら待つ)。
 * @param {import('../protocol/messages.mjs').Snapshot} snap @param {Heavy[]} heavy @param {string} [repo] @returns {boolean}
 */
export function waitExpected(snap, heavy, repo) {
  if (snap.waiting.length > 0) return true;
  if (snap.leases.some((l) => l.class === 'measure')) return true;
  const cpuHeld = snap.leases.some((l) => l.cpus > 0);
  let need = 0;
  for (const h of heavy) {
    if (h.jobClass === 'measure' && cpuHeld) return true;
    if (h.locks.some((k) => snap.leases.some((l) => l.locks.includes(k)))) return true;
    const cores = repo === undefined || h.profile === undefined ? undefined : snap.sized?.[usageKey(repo, h.profile)];
    const min = cores === undefined ? h.cpusMin : rightSize({ class: h.jobClass, cpus: { min: h.cpusMin, max: h.cpusMin } }, cores).cpus.min;
    need += Math.min(Math.max(min, 1), snap.capacity);
  }
  if (need <= snap.capacity - snap.used) return false;
  return !(heavy.length === 1 && typeof snap.spare === 'number' && need <= snap.spare);
}

/**
 * @param {Record<string, unknown>} input hook の標準入力
 * @param {{ env?: NodeJS.ProcessEnv, profilesFor?: (cwd: string) => NamedProfile[], shouldBackground?: BackgroundPolicy }} [opts]
 * @returns {Record<string, unknown> | null}
 */
export function preToolUse(input, { env = process.env, profilesFor = (cwd) => loadProfiles(repoRoot(cwd)).profiles, shouldBackground = () => true } = {}) {
  if (isOff(env)) return null;
  if (input.tool_name !== 'Bash') return null;
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  const command = typeof ti.command === 'string' ? ti.command : '';
  const profiles = profilesFor(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  /** @type {Heavy[]} */
  const heavy = [];
  /** @type {string[]} */
  const unshimmed = [];
  /** @type {string[]} 環境変数で shim を素通りさせる部分 */
  const overridden = [];
  /** @type {string[]} shim から見えない重い部分(./gradlew test・仮想環境の実行ファイル・activate の後の pytest) */
  const invisible = [];
  /** この単純コマンドより前で仮想環境を有効にしたか */
  let activated = false;

  /**
   * 単純コマンド 1 つを判定する。
   * @param {string[]} words @param {boolean} wrapped switchyard run で包んだ中(拒否の判定にかけない)
   */
  const visit = (words, wrapped) => {
    const { head, rest, bypass } = headOf(words);
    if (head === '') return;
    if (isActivate(head, rest)) {
      activated = true;
      return;
    }
    const base = basename(head);
    const text = [head, ...rest].join(' ');
    const bypassText = `${bypass.join(' ')} ${text}`;
    // bash -c "…" / sh -c '…': 引用の中の npm なども PATH の shim を通るので、中を単純コマンドとして見る
    if (SHELLS.has(base)) {
      const script = shellScript(rest);
      if (script !== null) {
        for (const inner of simpleCommands(script)) visit(inner, wrapped);
        return;
      }
    }
    // switchyard run で包んだ部分: 書いた人が包んだので拒否しない(包んだコマンドには普段どおり権限の確認が出る)。
    // 背景への判定は、包みが要求する性格と、中で PATH の shim が包むもので行う
    const run = switchyardRunArgs(head, rest);
    if (run !== null) {
      const w = wrapperOf(run, profiles);
      if (w.jobClass !== 'quick') heavy.push({ jobClass: w.jobClass, cpusMin: w.cpusMin, locks: w.locks });
      visit(w.argv, true);
      return;
    }
    // git は profile で分類しない。shim と同じく、index を書き換えるサブコマンドだけが鍵だけのジョブになる(CPU を持たないので前景のまま)
    if (base === 'git') {
      // git の鍵を取らない既定(SWITCHYARD_GIT が 1 でない)では、パスで呼ぶ git も環境変数の差し替えも拒否しない
      if (env.SWITCHYARD_GIT !== '1') return;
      const locks = GIT_LOCK_SUBCOMMANDS.has(gitSubcommand(rest).sub);
      if (head !== 'git' && !wrapped && locks) unshimmed.push(text);
      else if (!wrapped && locks && bypass.length > 0) overridden.push(bypassText);
      return;
    }
    const pathHead = head.includes('/');
    if (SHIM_WORDS.includes(base)) {
      // shim の語: 名前で呼べば、PATH の shim が同じ文字列を分類して包む。パスで直に呼ぶ実行ファイル(/usr/local/bin/npm など)だけが shim を迂回する。
      // 拒否はこの形だけに絞る(改善 2。IRC の記録で、shim の語でないものをパスで呼ぶ形への拒否 320 件がすべて誤りだった)
      const hit = classify(classifiableCommand([base, ...rest]), profiles);
      if (hit === null) return;
      if (!pathHead || isProjectLocal(head)) {
        if (hit.profile.class !== 'quick') heavy.push(needOf(hit.profile, hit.name));
        if (!wrapped && bypass.length > 0) overridden.push(bypassText);
        // 仮想環境の実行ファイル(パスで呼ぶ・有効にした後に名前で呼ぶ)は shim を通らない。包めば順番待ちに乗る
        else if (!wrapped && hit.profile.class !== 'quick' && (isVenvPath(head) || (activated && !pathHead))) invisible.push(text);
      } else if (!wrapped) {
        unshimmed.push(text);
      }
      return;
    }
    // shim の語でない部分は拒否しない。中で PATH の shim を通る(scripts/probe-run.sh の中の npm・#!/usr/bin/env node の node_modules/.bin)か、
    // shim の無いツールで、どちらも拒否しても順番待ちには乗らない。管理対象を起動する形なら背景に回すだけ:
    // パスで呼ぶか、当たった glob がその語で始まる(cat benchmarks/x・grep measure のように glob が語の途中に当たっただけの部分は起動しない)
    // ./gradlew test・./mvnw verify: パスで呼ぶビルドの包みには shim を置けない
    if (!wrapped && isHeavyWrapperScript(base, rest)) {
      invisible.push(text);
      heavy.push({ jobClass: 'batch', cpusMin: 1, locks: [] });
      return;
    }
    const ownText = classifiableCommand([head, ...rest]);
    const hit = classify(ownText, profiles) ?? (pathHead ? classify(classifiableCommand([base, ...rest]), profiles) : null);
    const launches = pathHead || profiles.some((np) => np.profile.match.some((g) => leadWord(g) === head && globMatch(g, ownText)));
    // switchyard run で包んだ中では、子に入れ子の印が立ち node の shim も包まないので、重さは包みの性格だけで決まる(ここでは数えない)
    if (!wrapped && hit !== null && launches && hit.profile.class !== 'quick') heavy.push(needOf(hit.profile, hit.name));
    // パスで呼ぶスクリプトの引数の中の shim の語・シェルから後ろ(scripts/probe-run.sh gates npm run bench など)は、中で PATH の shim が包みうる。
    // 背景への判定だけに使う(拒否にはかけない)
    if (pathHead) {
      const at = rest.findIndex((w) => SHIM_WORDS.includes(w) || SHELLS.has(w));
      if (at >= 0) visit(rest.slice(at), true);
    }
  };

  for (const words of simpleCommands(command)) visit(words, false);

  if (unshimmed.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: t(
          `[switchyard] shim の語(${SHIM_WORDS.join(' / ')})の実行ファイルをパスで直に呼ぶと、shim を迂回して順番待ちを通らない: ${unshimmed.join(' / ')}。` +
            'パスを付けずに名前で呼ぶ(例: npm test)か、`switchyard run -- <その部分>` で包んでから実行する(包んだコマンドには普段どおり権限の確認が出る)。',
          `[switchyard] calling a shimmed binary (${SHIM_WORDS.join(' / ')}) by path skips the shim and the queue: ${unshimmed.join(' / ')}. ` +
            'Call it by name (e.g. npm test), or wrap it as `switchyard run -- <that part>` (the wrapped command still goes through the usual permission check).',
        ),
      },
    };
  }
  // shim から見えない形が、それだけの 1 行(./gradlew test・./mvnw verify・.venv/bin/pytest -x)なら、拒否せずに
  // switchyard run -- で包んで走らせる(SWITCHYARD_WRAP=0 で以前どおり拒否して案内する)。
  // Claude Code は書き換えた後のコマンドで権限を確かめる(実物で確認: ./gradlew test だけを許していると、包んだ形は承認を求められる)
  // ので、確認をすり抜けることはない。拒否して Claude に包み直させても同じ確認が出るので、1 往復を減らすだけ。
  // && や | でつないだ形・前に代入がある形・複数行は、書き換えを誤りうるので拒否して案内する
  const wrapTarget = invisible.length === 1 && overridden.length === 0 && env.SWITCHYARD_WRAP !== '0' && !command.includes('\n') ? invisible[0] : null;
  if (wrapTarget !== null && simpleCommands(command).length === 1 && command.trim().startsWith(wrapTarget.split(' ')[0])) {
    const wrappedCommand = `switchyard run -- ${command.trim()}`;
    const background = ti.run_in_background !== true && shouldBackground(heavy);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, command: wrappedCommand, ...(background ? { run_in_background: true } : {}) } } };
  }
  if (invisible.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: t(
          `[switchyard] この形は shim から見えず、順番待ちを通らない: ${invisible.join(' / ')}。` +
            '`switchyard run -- <その部分>` で包んでから実行する(例: `switchyard run -- ./gradlew test`・`switchyard run -- .venv/bin/pytest`)。',
          `[switchyard] the shims cannot see this, so it would skip the queue: ${invisible.join(' / ')}. ` +
            'Wrap it as `switchyard run -- <that part>` (e.g. `switchyard run -- ./gradlew test`, `switchyard run -- .venv/bin/pytest`).',
        ),
      },
    };
  }
  if (overridden.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: t(
          `[switchyard] 環境変数(${BYPASS_VARS.join(' / ')}・env -i)を差し替えて呼ぶと、shim が順番待ちを通さない: ${overridden.join(' / ')}。` +
            '差し替えを外すか(PATH を足すなら PATH=/足す場所:$PATH の形)、`switchyard run -- <その部分>` で包んでから実行する。',
          `[switchyard] overriding the environment (${BYPASS_VARS.join(' / ')}, env -i) keeps the shim from queueing: ${overridden.join(' / ')}. ` +
            'Drop the override (to add to PATH, use PATH=/extra:$PATH), or wrap it as `switchyard run -- <that part>`.',
        ),
      },
    };
  }
  if (heavy.length > 0 && ti.run_in_background !== true && shouldBackground(heavy)) {
    // 決定(permissionDecision)は付けない。allow は権限の確認を飛ばすので使わない(設計 §12)
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, run_in_background: true } } };
  }
  return null;
}
