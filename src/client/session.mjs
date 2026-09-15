// @ts-check

/**
 * セッションの識別(設計 §4.3)。CLAUDE_CODE_SESSION_ID の先頭 8 文字。無ければ human:<親の pid>。
 * @param {NodeJS.ProcessEnv} [env] @param {number} [ppid] @returns {string}
 */
export function sessionId(env = process.env, ppid = process.ppid) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  return id !== undefined && id !== '' ? id.slice(0, 8) : `human:${ppid}`;
}

/** Claude のセッションからの呼び出しか(設計 §9.4 の権限の区別に使う) @param {NodeJS.ProcessEnv} [env] */
export function isClaudeSession(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID !== undefined && env.CLAUDE_CODE_SESSION_ID !== '';
}
