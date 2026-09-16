// @ts-check
// PreToolUse(Bash)の判定(設計 §9.2)。hook の標準入力の JSON を受け、出力の JSON を返す(何もしないなら null)。
//   - 背景への書き換え: PATH の shim か conductor run の包みが CPU を持つ走行(batch / measure)を起こす部分があれば、run_in_background だけを true にする。
//     コマンドの文字列は変えないので権限の判定に影響しない。だから判定は広めに取る(bash -c の中・( … )・$( … )・conductor run の `--` の後ろも見る)
//   - 拒否: shim の語の実行ファイルをパスで直に呼ぶ部分(/usr/local/bin/npm test・/usr/bin/git commit)だけ。本当に shim を迂回する形はこれしか無い。
//     shim の語でないものをパスで呼ぶ形(scripts/probe-run.sh・./node_modules/.bin/vitest)と shim の無い語は、重ければ背景に回すだけ(改善 2)
//   - 分類に渡すのは classifiableCommand の文字列(node -e のコードの中身では分類しない)
import { basename } from 'node:path';
import { parseArgs } from '../cli/args.mjs';
import { repoRoot } from '../config/context.mjs';
import { classifiableCommand, classify, globMatch, loadProfiles } from '../config/profiles.mjs';
import { conductorHome, pathsOf } from '../daemon/paths.mjs';
import { appendRecord } from '../daemon/store.mjs';
import { GIT_LOCK_SUBCOMMANDS } from '../shim/decide.mjs';
import { simpleCommands } from './shell.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../run/run.mjs').RunFlags} RunFlags */

/** shim を置く語(設計 §9.1)。shims/ の実物と同じ 8 語 */
export const SHIM_WORDS = ['npm', 'npx', 'node', 'cargo', 'pytest', 'go', 'make', 'git'];

/** `-c 文字列` の文字列をコマンドとして走らせるシェル */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** 後ろにコマンドが続くシェルの予約語 */
const RESERVED = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until']);
/** env の、値の語を取るオプション(GNU と BSD) */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir', '-P', '-S', '--split-string']);

/**
 * 単純コマンドの語の列の、先頭の語とそれより後ろの語。
 * VAR=値・予約語(if / then / do など)と、env [-u NAME などのオプション] / timeout [オプション] N / nice [-n N] / time / nohup / command を読み飛ばす。
 * @param {string[]} words @returns {{ head: string, rest: string[] }}
 */
function headOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || RESERVED.has(w)) {
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
      while (i < words.length && words[i].startsWith('-')) i += ENV_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
    } else if (w === 'time' || w === 'nohup' || w === 'command') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += 1;
    } else {
      break;
    }
  }
  return { head: words[i] ?? '', rest: words.slice(i + 1) };
}

/**
 * 空白で区切った部分の、先頭の語とそれより後ろの語(読み飛ばす語は headOf と同じ)。
 * @param {string} segment @returns {{ head: string, rest: string[] }}
 */
export function headWord(segment) {
  return headOf(segment.split(' ').filter((w) => w !== ''));
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
 * conductor run の部分なら、`run` より後ろの引数。`conductor` / `conductor.mjs` をどこから呼んでも、`node …/conductor.mjs run` でも同じ。
 * @param {string} head @param {string[]} rest @returns {string[] | null}
 */
function conductorRunArgs(head, rest) {
  const base = basename(head);
  if ((base === 'conductor' || base === 'conductor.mjs') && rest[0] === 'run') return rest.slice(1);
  if (base === 'node' && basename(rest[0] ?? '') === 'conductor.mjs' && rest[1] === 'run') return rest.slice(2);
  return null;
}

/**
 * conductor run の包みが要求する性格と、`--` の後ろの語。buildRequest と同じ順(--class → --profile → `--` の後ろの分類 → batch)で決める。
 * 引数が読めなければ `--` の後ろだけを見る(背景への判定は広めでよい)。
 * @param {string[]} args @param {NamedProfile[]} profiles @returns {{ jobClass: JobClass, argv: string[] }}
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
  return { jobClass: flags.class ?? named?.profile.class ?? 'batch', argv };
}

/**
 * @param {Record<string, unknown>} input hook の標準入力
 * @param {{ env?: NodeJS.ProcessEnv, profilesFor?: (cwd: string) => NamedProfile[] }} [opts]
 * @returns {Record<string, unknown> | null}
 */
export function preToolUse(input, { env = process.env, profilesFor = (cwd) => loadProfiles(repoRoot(cwd)).profiles } = {}) {
  if (env.CONDUCTOR_THINKER === '1') return null;
  if (input.tool_name !== 'Bash') return null;
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  const command = typeof ti.command === 'string' ? ti.command : '';
  const profiles = profilesFor(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const found = { heavy: false };
  /** @type {string[]} */
  const unshimmed = [];

  /**
   * 単純コマンド 1 つを判定する。
   * @param {string[]} words @param {boolean} wrapped conductor run で包んだ中(拒否の判定にかけない)
   */
  const visit = (words, wrapped) => {
    const { head, rest } = headOf(words);
    if (head === '') return;
    const base = basename(head);
    const text = [head, ...rest].join(' ');
    // bash -c "…" / sh -c '…': 引用の中の npm なども PATH の shim を通るので、中を単純コマンドとして見る
    if (SHELLS.has(base)) {
      const script = shellScript(rest);
      if (script !== null) {
        for (const inner of simpleCommands(script)) visit(inner, wrapped);
        return;
      }
    }
    // conductor run で包んだ部分: 書いた人が包んだので拒否しない(包んだコマンドには普段どおり権限の確認が出る)。
    // 背景への判定は、包みが要求する性格と、中で PATH の shim が包むもので行う
    const run = conductorRunArgs(head, rest);
    if (run !== null) {
      const w = wrapperOf(run, profiles);
      if (w.jobClass !== 'quick') found.heavy = true;
      visit(w.argv, true);
      return;
    }
    // git は profile で分類しない。shim と同じく、index を書き換えるサブコマンドだけが鍵だけのジョブになる(CPU を持たないので前景のまま)
    if (base === 'git') {
      if (head !== 'git' && !wrapped && GIT_LOCK_SUBCOMMANDS.has(rest[0] ?? '')) unshimmed.push(text);
      return;
    }
    const pathHead = head.includes('/');
    if (SHIM_WORDS.includes(base)) {
      // shim の語: 名前で呼べば、PATH の shim が同じ文字列を分類して包む。パスで直に呼ぶ実行ファイル(/usr/local/bin/npm など)だけが shim を迂回する。
      // 拒否はこの形だけに絞る(改善 2。IRC の記録で、shim の語でないものをパスで呼ぶ形への拒否 320 件がすべて誤りだった)
      const hit = classify(classifiableCommand([base, ...rest]), profiles);
      if (hit === null) return;
      if (!pathHead) {
        if (hit.profile.class !== 'quick') found.heavy = true;
      } else if (!wrapped) {
        unshimmed.push(text);
      }
      return;
    }
    // shim の語でない部分は拒否しない。中で PATH の shim を通る(scripts/probe-run.sh の中の npm・#!/usr/bin/env node の node_modules/.bin)か、
    // shim の無いツールで、どちらも拒否しても順番待ちには乗らない。管理対象を起動する形なら背景に回すだけ:
    // パスで呼ぶか、当たった glob がその語で始まる(cat benchmarks/x・grep measure のように glob が語の途中に当たっただけの部分は起動しない)
    const ownText = classifiableCommand([head, ...rest]);
    const hit = classify(ownText, profiles) ?? (pathHead ? classify(classifiableCommand([base, ...rest]), profiles) : null);
    const launches = pathHead || profiles.some((np) => np.profile.match.some((g) => leadWord(g) === head && globMatch(g, ownText)));
    // conductor run で包んだ中では、子に入れ子の印が立ち node の shim も包まないので、重さは包みの性格だけで決まる(ここでは数えない)
    if (!wrapped && hit !== null && launches && hit.profile.class !== 'quick') found.heavy = true;
    // パスで呼ぶスクリプトの引数の中の shim の語・シェルから後ろ(scripts/probe-run.sh gates npm run bench など)は、中で PATH の shim が包みうる。
    // 背景への判定だけに使う(拒否にはかけない)
    if (pathHead) {
      const at = rest.findIndex((w) => SHIM_WORDS.includes(w) || SHELLS.has(w));
      if (at >= 0) visit(rest.slice(at), true);
    }
  };

  for (const words of simpleCommands(command)) visit(words, false);

  /**
   * 判断を hooks.jsonl に残す(何をどれだけ背景へ回し、何を拒否したかを後から数えるため)。
   * 書けなくても判断は返す(記録は補助で、失敗で作業を止めない)。
   * @param {'background' | 'deny'} decision
   */
  const record = (decision) => {
    try {
      appendRecord(pathsOf(conductorHome(env)).hooks, {
        at: Date.now(),
        kind: 'hook',
        decision,
        session: typeof input.session_id === 'string' ? input.session_id : '',
        cwd: typeof input.cwd === 'string' ? input.cwd : '',
        cmd: command,
      });
    } catch {
      /* 記録できないときは黙って進む */
    }
  };

  if (unshimmed.length > 0) {
    record('deny');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[conductor] shim の語(${SHIM_WORDS.join(' / ')})の実行ファイルをパスで直に呼ぶと、shim を迂回して順番待ちを通らない: ${unshimmed.join(' / ')}。` +
          'パスを付けずに名前で呼ぶ(例: npm test)か、`conductor run -- <その部分>` で包んでから実行する(包んだコマンドには普段どおり権限の確認が出る)。',
      },
    };
  }
  if (found.heavy && ti.run_in_background !== true) {
    record('background');
    // 決定(permissionDecision)は付けない。allow は権限の確認を飛ばすので使わない(設計 §12)
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, run_in_background: true } } };
  }
  return null;
}
