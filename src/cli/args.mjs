// @ts-check
// CLI の引数の解析。
/** @typedef {import('../run/run.mjs').RunFlags} RunFlags */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').Preempt} Preempt */
/** @typedef {import('../core/types.mjs').CpuRange} CpuRange */

/**
 * @typedef {(
 *   { cmd: 'run', flags: RunFlags, argv: string[] } |
 *   { cmd: 'top' } |
 *   { cmd: 'why', jobId: string } |
 *   { cmd: 'ack', jobId: string, session: string | null } |
 *   { cmd: 'probe', seconds: number, argv: string[] } |
 *   { cmd: 'help' }
 * )} Command
 */

export const USAGE = [
  '使い方:',
  '  conductor run [--profile 名前] [--why "目的"] [--class quick|batch|measure] [--cpus 最小..最大] [--lock 名前]... [--preempt pause|throttle|never] -- <コマンド...>',
  '  conductor top',
  '  conductor why <job>',
  '  conductor ack <job> [--session <id>]',
  '  conductor probe <秒> -- <コマンド...>',
].join('\n');

export class UsageError extends Error {}

/** `4` は 4..4、`2..10` は 2..10、`0` と `0..0` は鍵だけのジョブ(設計 §5.2) @param {string} v @returns {CpuRange} */
export function parseCpus(v) {
  if (v === '0' || v === '0..0') return { min: 0, max: 0 };
  const parts = v.split('..');
  const nums = parts.map((x) => (x === '' ? NaN : Number(x)));
  const ok = nums.every((n) => Number.isInteger(n) && n >= 1);
  if (ok && parts.length === 1) return { min: nums[0], max: nums[0] };
  if (ok && parts.length === 2 && nums[1] >= nums[0]) return { min: nums[0], max: nums[1] };
  throw new UsageError(`--cpus は 4 か 2..10 の形(鍵だけのジョブは 0..0): ${v}`);
}

/** @param {string[]} rest @returns {Command} */
function parseRun(rest) {
  const sep = rest.indexOf('--');
  if (sep < 0) throw new UsageError('run はコマンドの前に -- が要る');
  const opts = rest.slice(0, sep);
  const argv = rest.slice(sep + 1);
  if (argv.length === 0) throw new UsageError('-- の後にコマンドが無い');
  /** @type {RunFlags} */
  const flags = {};
  for (let i = 0; i < opts.length; i += 1) {
    const name = opts[i];
    const take = () => {
      const value = opts[i + 1];
      if (value === undefined) throw new UsageError(`${name} に値が無い`);
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
        if (v !== 'quick' && v !== 'batch' && v !== 'measure') throw new UsageError('--class は quick / batch / measure');
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
        if (v !== 'pause' && v !== 'throttle' && v !== 'never') throw new UsageError('--preempt は pause / throttle / never');
        flags.preempt = v;
        break;
      }
      default:
        throw new UsageError(`知らないオプション: ${name}`);
    }
  }
  if (flags.cpus?.max === 0 && (flags.locks ?? []).length === 0 && flags.profile === undefined) {
    throw new UsageError('--cpus 0..0(鍵だけのジョブ)には --lock が 1 本以上要る');
  }
  return { cmd: 'run', flags, argv };
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
    case 'top':
      if (rest.length > 0) throw new UsageError('top は引数を取らない');
      return { cmd: 'top' };
    case 'why':
      if (rest.length !== 1) throw new UsageError('why にはジョブの id を 1 つ渡す');
      return { cmd: 'why', jobId: rest[0] };
    case 'ack': {
      if (rest.length === 1) return { cmd: 'ack', jobId: rest[0], session: null };
      if (rest.length === 3 && rest[1] === '--session') return { cmd: 'ack', jobId: rest[0], session: rest[2] };
      throw new UsageError('ack <job> [--session <id>]');
    }
    case 'probe': {
      if (rest.indexOf('--') !== 1) throw new UsageError('probe <秒> -- <コマンド...>');
      const seconds = rest[0] === '' ? NaN : Number(rest[0]);
      if (!(seconds > 0)) throw new UsageError(`probe の秒数は正の数: ${rest[0]}`);
      const argv = rest.slice(2);
      if (argv.length === 0) throw new UsageError('-- の後にコマンドが無い');
      return { cmd: 'probe', seconds, argv };
    }
    default:
      throw new UsageError(`知らないサブコマンド: ${cmd}`);
  }
}
