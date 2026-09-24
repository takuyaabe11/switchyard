// @ts-check
// switchyard uninstall: plugin を外す前の後片付けを 1 回で行う。
//   1. デーモンを止める
//   2. セッションの環境ファイル(CLAUDE_ENV_FILE と ~/.claude/session-env の下)から、switchyard の shims を PATH に足す行を取り除く
//   3. 記録の置き場(~/.switchyard か SWITCHYARD_HOME)の、switchyard が作るファイルだけを消し、空になれば置き場も消す
// 置き場に switchyard のものでないファイルが 1 つでもあれば、何も消さずに知らせるだけにする。
// SWITCHYARD_HOME を誤って $HOME などに向けていても、config.json のようなよくある名前のファイルを消さないため。
// 開いているセッションのシェルには PATH が残るので、開き直すよう伝える。plugin そのものを外すのは Claude Code の役目。
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n.mjs';

/** switchyard が記録の置き場に作るファイル(回した 1 世代前・書きかけの一時ファイル・取り込み中の別名を含む) */
const OWN_FILE = /^(state\.json|events\.jsonl|hooks\.jsonl|unmanaged\.jsonl|observed\.jsonl|update-check\.json|config\.json|switchyardd\.log|switchyardd\.sock|daemon\.lock)(\.1|\.[0-9][^/]*\.(tmp|taking))?$/;

/** 環境ファイルの、shims を PATH に足す行(src/hooks/session.mjs の pathExportLine が書く形) */
const SHIMS_LINE = /^export PATH='(.*\/shims)':"\$PATH"$/;

/**
 * switchyard の shims を指す行か。いまの plugin の shims か、パスに switchyard を含むか、そこに switchyard の shim の本体がある。
 * @param {string} path @param {string} own
 */
const isOurShims = (path, own) => path === own || /switchyard/.test(path) || existsSync(join(path, '_shim.sh'));

/**
 * 環境ファイルの中身から、switchyard の shims の行を除く。他の行は 1 文字も変えない。
 * @param {string} text @param {string} own @returns {{ text: string, removed: number }}
 */
export function withoutShimLines(text, own) {
  let removed = 0;
  const kept = text.split('\n').filter((l) => {
    const m = SHIMS_LINE.exec(l.trim());
    if (m !== null && isOurShims(m[1], own)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { text: kept.join('\n'), removed };
}

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) out.push(p);
    } catch {
      // 読んでいる間に消えた
    }
  }
  return out;
}

/**
 * @typedef {{ envFiles: Array<{ file: string, removed: number }>, deleted: string[], kept: string[], homeRemoved: boolean }} UninstallResult
 */

/**
 * 環境ファイルと記録の置き場を片付ける(デーモンを止めるのは呼び出し元)。dryRun なら何も変えず、することだけを返す。
 * @param {{ home: string, env: NodeJS.ProcessEnv, ownShims: string, keepLogs: boolean, dryRun: boolean }} o
 * @returns {UninstallResult}
 */
export function cleanUp({ home, env, ownShims, keepLogs, dryRun }) {
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude');
  const candidates = new Set(filesUnder(join(claudeDir, 'session-env')));
  if (env.CLAUDE_ENV_FILE !== undefined && existsSync(env.CLAUDE_ENV_FILE)) candidates.add(env.CLAUDE_ENV_FILE);
  /** @type {UninstallResult['envFiles']} */
  const envFiles = [];
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const r = withoutShimLines(text, ownShims);
    if (r.removed === 0) continue;
    envFiles.push({ file, removed: r.removed });
    if (!dryRun) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, r.text);
      renameSync(tmp, file);
    }
  }
  /** @type {string[]} */
  const deleted = [];
  /** @type {string[]} */
  const kept = [];
  let homeRemoved = false;
  if (!keepLogs && existsSync(home)) {
    const names = readdirSync(home);
    for (const name of names) if (!OWN_FILE.test(name)) kept.push(join(home, name));
    if (kept.length === 0) {
      for (const name of names) {
        deleted.push(join(home, name));
        if (!dryRun) unlinkSync(join(home, name));
      }
      homeRemoved = true;
      if (!dryRun) rmdirSync(home);
    }
  }
  return { envFiles, deleted, kept, homeRemoved };
}

/**
 * @param {UninstallResult} r @param {{ home: string, daemon: string, keepLogs: boolean, dryRun: boolean }} o @returns {string}
 */
export function formatUninstall(r, { home, daemon, keepLogs, dryRun }) {
  const lines = [dryRun ? t('(--dry-run: 何も変えていない。するのは次のこと)', '(--dry-run: nothing was changed; this is what it would do)') : ''];
  lines.push(t(`デーモン: ${daemon}`, `Daemon: ${daemon}`));
  if (r.envFiles.length === 0) lines.push(t('環境ファイル: shims の行は無かった', 'Session env files: no shims line found'));
  for (const f of r.envFiles) {
    lines.push(
      dryRun
        ? t(`環境ファイル: ${f.file} から shims の行を ${f.removed} 行取り除く`, `Session env file: would remove ${f.removed} shims line(s) from ${f.file}`)
        : t(`環境ファイル: ${f.file} から shims の行を ${f.removed} 行取り除いた`, `Session env file: removed ${f.removed} shims line(s) from ${f.file}`),
    );
  }
  if (keepLogs) lines.push(t(`記録: ${home} は残す(--keep-logs)`, `Logs: kept in ${home} (--keep-logs)`));
  else if (r.deleted.length === 0 && r.kept.length === 0) lines.push(t(`記録: ${home} は無い`, `Logs: ${home} does not exist`));
  else {
    if (r.homeRemoved) {
      lines.push(
        dryRun
          ? t(`記録: ${home} の ${r.deleted.length} 個のファイルと、置き場そのものを消す`, `Logs: would delete ${r.deleted.length} file(s) in ${home}, and ${home} itself`)
          : t(`記録: ${home} の ${r.deleted.length} 個のファイルと、置き場そのものを消した`, `Logs: deleted ${r.deleted.length} file(s) in ${home}, and ${home} itself`),
      );
    }
    else lines.push(t(`記録: switchyard のものではないファイルがあるので、${home} は何も消さない(確かめて手で消す): ${r.kept.join(', ')}`, `Logs: nothing deleted, because ${home} holds files switchyard did not write (check and delete by hand): ${r.kept.join(', ')}`));
  }
  lines.push(
    t(
      '残りの手順: Claude Code で /plugin uninstall switchyard@switchyard を実行し、開いているセッションを開き直す(そのシェルの PATH には shims が残っている)',
      'Left to do: run /plugin uninstall switchyard@switchyard in Claude Code, and reopen open sessions (their shells still have the shims on PATH)',
    ),
  );
  return `${lines.filter((l) => l !== '').join('\n')}\n`;
}
