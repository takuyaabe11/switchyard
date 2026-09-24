// @ts-check
import { chmodSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IS_WINDOWS, socketPath } from '../platform.mjs';

/** 記録の置き場所の権限。記録にはコマンドの全文(引数に渡した秘密も)が入るので、持ち主だけが読めるようにする */
export const PRIVATE_DIR_MODE = 0o700;
/** 記録のファイルの権限 */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * 置き場所を持ち主だけが読める形で作る。既にあれば権限を締め直す(0.7.0 以前は 755 で作っていた)。
 * 締め直せない(持ち主でない)ときは、そのまま使う。
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Windows の権限はモードの数でなく ACL で決まる(置き場所はユーザーのプロファイルの下で、既定で本人だけが読める)
  if (IS_WINDOWS) return;
  try {
    if ((lstatSync(dir).mode & 0o077) !== 0) chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // 持ち主でない・消えた: 締め直さずに進む
  }
}

/**
 * 置き場所の中のファイルを、持ち主だけが読める形に締め直す(0.7.0 以前に 644 で作った記録)。socket と置き場所の外へのリンクは触らない。
 * @param {string} dir
 */
export function tightenFiles(dir) {
  if (IS_WINDOWS) return;
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile() && (st.mode & 0o077) !== 0) chmodSync(join(dir, name), PRIVATE_FILE_MODE);
    } catch {
      // 読んでいる間に消えた
    }
  }
}

/** Unix socket のパス長の上限。macOS は 104 バイトなので、余裕を見て 100 */
export const SOCKET_PATH_LIMIT = 100;

/** @param {NodeJS.ProcessEnv} [env] @returns {string} */
export function switchyardHome(env = process.env) {
  return env.SWITCHYARD_HOME ?? join(homedir(), '.switchyard');
}

/** @param {string} home */
export function pathsOf(home) {
  return {
    home,
    // Windows は名前付きパイプ(src/platform.mjs)
    sock: socketPath(home),
    lock: join(home, 'daemon.lock'),
    state: join(home, 'state.json'),
    events: join(home, 'events.jsonl'),
    unmanaged: join(home, 'unmanaged.jsonl'),
    // 観察だけのモード(SWITCHYARD_OBSERVE=1)で走った重い走行の始まりと終わり
    observed: join(home, 'observed.jsonl'),
    // PreToolUse が背景へ回した・拒否した判断の記録(デーモンを通らないので events.jsonl とは別)
    hooks: join(home, 'hooks.jsonl'),
    log: join(home, 'switchyardd.log'),
    // Bash の時間切れで切られたコマンド(次に同じ場所で走るとき時間切れを延ばす)と、PreToolUse の sh のふるいが読む一覧
    timeouts: join(home, 'timeouts.json'),
    timeoutsSieve: join(home, 'timeouts.txt'),
  };
}
