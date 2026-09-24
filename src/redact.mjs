// @ts-check
// 記録に残すコマンドの文字列から秘密を隠す。
// switchyard はコマンドを events.jsonl・hooks.jsonl・state.json などに残す。利用者は API キーやパスワードを
// 引数や環境変数の代入で渡すことがある(STRIPE_SECRET_KEY=sk_live_… pnpm tsx …・mysql -pXXX・-Dspring.datasource.password=…)。
// 既定(masked)は、秘密らしい値だけを *** に置き換える。full はそのまま、none はコマンドの最初の語だけを残す。
// SWITCHYARD_LOG_COMMANDS で選ぶ。ここで隠すのは記録と表示だけで、走らせるコマンドは変えない。

export const MASK = '***';

/** 名前が秘密らしい(環境変数・JVM のプロパティ・旗の名前) */
const SECRET_NAME = /(secret|token|passw(or)?d|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth|session|cookie|signature|dsn)/i;

/** 形で分かるトークン */
const TOKEN_SHAPES = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI・Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS のアクセスキー
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm
];

/**
 * 秘密らしい値を *** に置き換える。
 * @param {string} cmd @returns {string}
 */
export function maskSecrets(cmd) {
  let s = cmd;
  // URL の中の資格情報: scheme://user:pass@host
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+):[^\s@'"]+@/gi, `$1:${MASK}@`);
  // Authorization などのヘッダ(-H 'Authorization: Bearer xxx'・X-Api-Key: xxx)
  s = s.replace(/\b(authorization|proxy-authorization|x-[a-z0-9-]*(?:key|token|secret)[a-z0-9-]*)\s*:\s*[^'"\n]+/gi, `$1: ${MASK}`);
  // 秘密らしい名前の代入: NAME=値・-Dname.password=値・--api-key=値
  s = s.replace(/(^|[\s'"(;&|])(--?|-D)?([A-Za-z_][A-Za-z0-9_.-]*)=(\S+)/g, (m, pre, dash, name, value) =>
    SECRET_NAME.test(name) && value !== MASK ? `${pre}${dash ?? ''}${name}=${MASK}` : m,
  );
  // 秘密らしい名前の旗の次の語: --password x・--token x・--api-key x
  s = s.replace(/(^|\s)(--?[A-Za-z0-9-]*(?:passw(?:or)?d|token|secret|api-?key|access-?key|credential)[A-Za-z0-9-]*)\s+(?!-)(\S+)/gi, `$1$2 ${MASK}`);
  // mysql 系の -p<パスワード>(-p だけのときは尋ねる形なので残す)
  s = s.replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*?\s)-p(\S+)/g, `$1-p${MASK}`);
  for (const re of TOKEN_SHAPES) s = s.replace(re, MASK);
  return s;
}

/**
 * 記録に残すコマンドの文字列。SWITCHYARD_LOG_COMMANDS: masked(既定)・full・none。
 * @param {string} cmd @param {NodeJS.ProcessEnv} env @returns {string}
 */
export function loggedCommand(cmd, env) {
  const mode = env.SWITCHYARD_LOG_COMMANDS;
  if (mode === 'full') return cmd;
  if (mode === 'none') {
    const head = cmd.trim().split(/\s+/)[0] ?? '';
    return head === '' ? MASK : `${head.split('/').pop()} ${MASK}`;
  }
  return maskSecrets(cmd);
}
