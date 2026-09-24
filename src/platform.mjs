// @ts-check
// Windows と POSIX の違いをここに集める。Windows では Git for Windows の bash(Claude Code の Bash ツールと同じもの)の上で動かす。
// Windows で弱まること:
//   - プロセスグループが無いので、子のグループを確かめない(pgid は null)。止めるときは taskkill /T で子の木ごと止める
//   - そのため、逃げた子の検出・グループごとの RSS・計測に道を譲る一時停止(pause / throttle)は効かない
//   - デーモンとの接続は Unix socket の代わりに名前付きパイプ
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * デーモンの待ち受けの名前。POSIX は置き場所の中の Unix socket、Windows は置き場所ごとに決まる名前付きパイプ。
 * @param {string} home @param {NodeJS.Platform} [platform] @returns {string}
 */
export function socketPath(home, platform = process.platform) {
  if (platform !== 'win32') return join(home, 'switchyardd.sock');
  const id = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\switchyardd-${id}`;
}

/**
 * Windows のパス(C:\Users\a\x)を、Git Bash が読む形(/c/Users/a/x)にする。それ以外はそのまま。
 * @param {string} p @returns {string}
 */
export function toBashPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m === null) return p.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/**
 * toBashPath の逆(/c/Users/a/x → C:\Users\a\x)。Windows でファイルを確かめるときに使う。形が違えばそのまま。
 * @param {string} p @returns {string}
 */
export function fromBashPath(p) {
  const m = /^\/([A-Za-z])\/(.*)$/.exec(p);
  if (m === null) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
}

/**
 * Git for Windows の bash.exe を探す。見つからなければ null。
 * C:\Windows\System32\bash.exe は WSL の入口で、別の機械の中で走ってしまうので使わない。
 * @param {NodeJS.ProcessEnv} [env] @param {(p: string) => boolean} [exists] @returns {string | null}
 */
export function findGitBash(env = process.env, exists = existsSync) {
  /** @type {string[]} */
  const candidates = [];
  if (env.SWITCHYARD_BASH) candidates.push(env.SWITCHYARD_BASH);
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  // git.exe の場所(…\Git\cmd\git.exe)から辿る
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (/[\\/]git[\\/](cmd|bin|usr[\\/]bin)[\\/]?$/i.test(dir)) candidates.push(join(dir.replace(/[\\/](cmd|bin|usr[\\/]bin)[\\/]?$/i, ''), 'bin', 'bash.exe'));
  }
  for (const c of candidates) {
    if (/[\\/]system32[\\/]bash\.exe$/i.test(c)) continue;
    if (exists(c)) return c;
  }
  return null;
}

/**
 * Windows で、子の木(pid とその子孫)ごと止める。既に居なければ何もしない。
 * @param {number} pid @returns {boolean} 送れたら true
 */
export function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows で、その pid が node として走っているか(pid の使い回しに備える。POSIX の ps -o command= の代わり)。
 * コマンドラインまでは安く読めないので、実行ファイルの名前だけを見る。
 * @param {number} pid @returns {boolean}
 */
export function isNodePid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return /^"node(\.exe)?"/im.test(out.trim());
  } catch {
    return false;
  }
}
