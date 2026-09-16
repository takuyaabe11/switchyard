// @ts-check
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Unix socket のパス長の上限。macOS は 104 バイトなので、余裕を見て 100 */
export const SOCKET_PATH_LIMIT = 100;

/** @param {NodeJS.ProcessEnv} [env] @returns {string} */
export function conductorHome(env = process.env) {
  return env.CONDUCTOR_HOME ?? join(homedir(), '.conductor');
}

/** @param {string} home */
export function pathsOf(home) {
  return {
    home,
    sock: join(home, 'conductord.sock'),
    lock: join(home, 'daemon.lock'),
    state: join(home, 'state.json'),
    events: join(home, 'events.jsonl'),
    unmanaged: join(home, 'unmanaged.jsonl'),
    // PreToolUse が背景へ回した・拒否した判断の記録(デーモンを通らないので events.jsonl とは別)
    hooks: join(home, 'hooks.jsonl'),
    log: join(home, 'conductord.log'),
  };
}
