// @ts-check
// CLI の引数の解析。
import { t } from '../i18n.mjs';
/** @typedef {import('../run/run.mjs').RunFlags} RunFlags */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').Preempt} Preempt */
/** @typedef {import('../core/types.mjs').CpuRange} CpuRange */

/**
 * @typedef {(
 *   { cmd: 'run', flags: RunFlags, argv: string[] } |
 *   { cmd: 'top' } |
 *   { cmd: 'stop' } |
 *   { cmd: 'restart' } |
 *   { cmd: 'why', jobId: string } |
 *   { cmd: 'ack', jobId: string, session: string | null } |
 *   { cmd: 'probe', seconds: number, argv: string[] } |
 *   ReplayCommand |
 *   ReportCommand |
 *   { cmd: 'help' }
 * )} Command
 */
/** @typedef {{ cmd: 'replay', cwdPrefix: string | null, sinceDays: number | null, config: string | null, examples: number, dir: string | null }} ReplayCommand */
/** @typedef {{ cmd: 'report', repoPrefix: string | null, sinceDays: number | null }} ReportCommand */

export const USAGE = t(
  [
    '使い方:',
    '  switchyard run [--profile 名前] [--why "目的"] [--class quick|batch|measure] [--cpus 最小..最大] [--lock 名前]... [--preempt pause|throttle|never] -- <コマンド...>',
    '  switchyard top',
    '  switchyard stop',
    '  switchyard restart',
    '  switchyard why <job>',
    '  switchyard ack <job> [--session <id>]',
    '  switchyard probe <秒> -- <コマンド...>',
    '  switchyard replay [--cwd 前方一致] [--since 日数d] [--config switchyard.json] [--examples 件数] [--dir 記録の根]',
    '  switchyard report [--repo 前方一致] [--since 日数d]',
  ].join('\n'),
  [
    'Usage:',
    '  switchyard run [--profile name] [--why "purpose"] [--class quick|batch|measure] [--cpus min..max] [--lock name]... [--preempt pause|throttle|never] -- <command...>',
    '  switchyard top',
    '  switchyard stop',
    '  switchyard restart',
    '  switchyard why <job>',
    '  switchyard ack <job> [--session <id>]',
    '  switchyard probe <seconds> -- <command...>',
    '  switchyard replay [--cwd prefix] [--since <days>d] [--config switchyard.json] [--examples count] [--dir log-root]',
    '  switchyard report [--repo prefix] [--since <days>d]',
  ].join('\n'),
);

export class UsageError extends Error {}

/** `4` は 4..4、`2..10` は 2..10、`0` と `0..0` は鍵だけのジョブ(設計 §5.2) @param {string} v @returns {CpuRange} */
export function parseCpus(v) {
  if (v === '0' || v === '0..0') return { min: 0, max: 0 };
  const parts = v.split('..');
  const nums = parts.map((x) => (x === '' ? NaN : Number(x)));
  const ok = nums.every((n) => Number.isInteger(n) && n >= 1);
  if (ok && parts.length === 1) return { min: nums[0], max: nums[0] };
  if (ok && parts.length === 2 && nums[1] >= nums[0]) return { min: nums[0], max: nums[1] };
  throw new UsageError(t(`--cpus は 4 か 2..10 の形(鍵だけのジョブは 0..0): ${v}`, `--cpus takes 4 or 2..10 (0..0 for a locks-only job): ${v}`));
}

/** @param {string[]} rest @returns {Command} */
function parseRun(rest) {
  const sep = rest.indexOf('--');
  if (sep < 0) throw new UsageError(t('run はコマンドの前に -- が要る', 'run needs -- before the command'));
  const opts = rest.slice(0, sep);
  const argv = rest.slice(sep + 1);
  if (argv.length === 0) throw new UsageError(t('-- の後にコマンドが無い', 'no command after --'));
  /** @type {RunFlags} */
  const flags = {};
  for (let i = 0; i < opts.length; i += 1) {
    const name = opts[i];
    const take = () => {
      const value = opts[i + 1];
      if (value === undefined) throw new UsageError(t(`${name} に値が無い`, `${name} needs a value`));
      i += 1;
      return value;
    };
    switch (name) {
      case '--profile':
        flags.profile = take();
        break;
      case '--why':
        flags.why = take();
        break;
      case '--class': {
        const v = take();
        if (v !== 'quick' && v !== 'batch' && v !== 'measure') throw new UsageError(t('--class は quick / batch / measure', '--class is quick / batch / measure'));
        flags.class = v;
        break;
      }
      case '--cpus':
        flags.cpus = parseCpus(take());
        break;
      case '--lock':
        flags.locks = [...(flags.locks ?? []), take()];
        break;
      case '--preempt': {
        const v = take();
        if (v !== 'pause' && v !== 'throttle' && v !== 'never') throw new UsageError(t('--preempt は pause / throttle / never', '--preempt is pause / throttle / never'));
        flags.preempt = v;
        break;
      }
      default:
        throw new UsageError(t(`知らないオプション: ${name}`, `unknown option: ${name}`));
    }
  }
  if (flags.cpus?.max === 0 && (flags.locks ?? []).length === 0 && flags.profile === undefined) {
    throw new UsageError(t('--cpus 0..0(鍵だけのジョブ)には --lock が 1 本以上要る', '--cpus 0..0 (a locks-only job) needs at least one --lock'));
  }
  return { cmd: 'run', flags, argv };
}

/** @param {string[]} rest @returns {ReplayCommand} */
function parseReplay(rest) {
  /** @type {ReplayCommand} */
  const out = { cmd: 'replay', cwdPrefix: null, sinceDays: null, config: null, examples: 5, dir: null };
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i];
    const take = () => {
      const value = rest[i + 1];
      if (value === undefined) throw new UsageError(t(`${name} に値が無い`, `${name} needs a value`));
      i += 1;
      return value;
    };
    switch (name) {
      case '--cwd':
        out.cwdPrefix = take();
        break;
      case '--since': {
        const v = take();
        const m = /^([1-9][0-9]*)d$/.exec(v);
        if (m === null) throw new UsageError(t(`--since は 14d の形(1 以上の日数): ${v}`, `--since takes the form 14d (1 or more days): ${v}`));
        out.sinceDays = Number(m[1]);
        break;
      }
      case '--config':
        out.config = take();
        break;
      case '--examples': {
        const v = take();
        if (!/^[0-9]+$/.test(v)) throw new UsageError(t(`--examples は 0 以上の整数: ${v}`, `--examples takes an integer of 0 or more: ${v}`));
        out.examples = Number(v);
        break;
      }
      case '--dir':
        out.dir = take();
        break;
      default:
        throw new UsageError(t(`知らないオプション: ${name}`, `unknown option: ${name}`));
    }
  }
  return out;
}

/** @param {string[]} rest @returns {ReportCommand} */
function parseReport(rest) {
  /** @type {ReportCommand} */
  const out = { cmd: 'report', repoPrefix: null, sinceDays: null };
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i];
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(t(`${name} に値が無い`, `${name} needs a value`));
    i += 1;
    if (name === '--repo') out.repoPrefix = value;
    else if (name === '--since') {
      const m = /^([1-9][0-9]*)d$/.exec(value);
      if (m === null) throw new UsageError(t(`--since は 14d の形(1 以上の日数): ${value}`, `--since takes the form 14d (1 or more days): ${value}`));
      out.sinceDays = Number(m[1]);
    } else throw new UsageError(t(`知らないオプション: ${name}`, `unknown option: ${name}`));
  }
  return out;
}

/** @param {string[]} args @returns {Command} */
export function parseArgs(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { cmd: 'help' };
    case 'run':
      return parseRun(rest);
    case 'replay':
      return parseReplay(rest);
    case 'report':
      return parseReport(rest);
    case 'top':
      if (rest.length > 0) throw new UsageError(t('top は引数を取らない', 'top takes no arguments'));
      return { cmd: 'top' };
    case 'stop':
      if (rest.length > 0) throw new UsageError(t('stop は引数を取らない', 'stop takes no arguments'));
      return { cmd: 'stop' };
    case 'restart':
      if (rest.length > 0) throw new UsageError(t('restart は引数を取らない', 'restart takes no arguments'));
      return { cmd: 'restart' };
    case 'why':
      if (rest.length !== 1) throw new UsageError(t('why にはジョブの id を 1 つ渡す', 'why takes one job id'));
      return { cmd: 'why', jobId: rest[0] };
    case 'ack': {
      if (rest.length === 1) return { cmd: 'ack', jobId: rest[0], session: null };
      if (rest.length === 3 && rest[1] === '--session') return { cmd: 'ack', jobId: rest[0], session: rest[2] };
      throw new UsageError('ack <job> [--session <id>]');
    }
    case 'probe': {
      if (rest.indexOf('--') !== 1) throw new UsageError(t('probe <秒> -- <コマンド...>', 'probe <seconds> -- <command...>'));
      const seconds = rest[0] === '' ? NaN : Number(rest[0]);
      if (!(seconds > 0)) throw new UsageError(t(`probe の秒数は正の数: ${rest[0]}`, `probe seconds must be positive: ${rest[0]}`));
      const argv = rest.slice(2);
      if (argv.length === 0) throw new UsageError(t('-- の後にコマンドが無い', 'no command after --'));
      return { cmd: 'probe', seconds, argv };
    }
    default:
      throw new UsageError(t(`知らないサブコマンド: ${cmd}`, `unknown subcommand: ${cmd}`));
  }
}
