// @ts-check
// 失敗した走行が、コードではなく環境のせいで落ちたかもしれないかを見分ける。純関数。
// Claude は、タイムアウトやメモリ不足で落ちたテストをコードのバグと思い込み、関係ない修正を始めることがある。
// デーモンは走行中の機械の様子(他の重い走行との重なり・忙しさ・空きメモリ・計測のための一時停止)を知っているので、
// 当てはまる手がかりを挙げて「空いてから走らせ直す」よう伝える。確かな判定ではなく、手がかりの一覧。
import { t } from '../i18n.mjs';

/**
 * 走行中に測った機械の様子。測れていないものは null。
 * maxOtherLoad は、機械全体の使用コア数からこの走行の分(道具に渡したスレッド数)を引いた最大。
 * switchyard を通っていない負荷(Docker・他の人・素のままの走行)も入る。
 * @typedef {{ maxOthers: number, maxBusyCores: number | null, maxOtherLoad: number | null, minAvailMb: number | null, heldMs: number }} RunStats
 */

/** 機械がほぼ全部忙しかったとみなす割合 */
export const BUSY_RATIO = 0.9;
/** この走行以外がこれだけのコアを使っていたら、取り合ったとみなす */
export const OTHER_LOAD_MIN = 1;
/** 一時停止をここまで受けたら手がかりに数える(ms) */
export const HELD_MIN_MS = 1_000;

/**
 * @param {{ code: number | null, killedByCaller: boolean, stats: RunStats | null, cores: number, memFloorMb: number | null }} input
 * @returns {string[]} 手がかり(無ければ空)
 */
export function environmentalReasons({ code, killedByCaller, stats, cores, memFloorMb }) {
  if (code === 0 || code === null || killedByCaller) return [];
  /** @type {string[]} */
  const out = [];
  if (code === 137) {
    out.push(t('SIGKILL で終わった(メモリ不足で OS に止められたことが多い)', 'it ended with SIGKILL (often the out-of-memory killer)'));
  }
  if (stats !== null) {
    if (stats.minAvailMb !== null && memFloorMb !== null && stats.minAvailMb < memFloorMb) {
      out.push(t(`走行中に空きメモリが ${Math.round(stats.minAvailMb)}MB まで減った`, `free memory fell to ${Math.round(stats.minAvailMb)}MB while it ran`));
    }
    if (stats.maxBusyCores !== null && stats.maxOtherLoad !== null && stats.maxBusyCores >= cores * BUSY_RATIO && stats.maxOtherLoad >= OTHER_LOAD_MIN) {
      const other = Math.round(stats.maxOtherLoad * 10) / 10;
      out.push(
        stats.maxOthers > 0
          ? t(
              `機械の ${cores} コアがほぼ全部使われ、そのうち約 ${other} コアは他の走行(switchyard の重い走行 ${stats.maxOthers} 本を含む)が使っていた`,
              `nearly all ${cores} cores were busy, about ${other} of them used by other work (including ${stats.maxOthers} other heavy run(s) in switchyard)`,
            )
          : t(
              `機械の ${cores} コアがほぼ全部使われ、そのうち約 ${other} コアは switchyard の外の処理が使っていた`,
              `nearly all ${cores} cores were busy, about ${other} of them used by work outside switchyard`,
            ),
      );
    }
    if (stats.heldMs >= HELD_MIN_MS) {
      out.push(t(`計測に道を譲るため ${Math.round(stats.heldMs / 1000)} 秒止められていた`, `it was paused or slowed for ${Math.round(stats.heldMs / 1000)} s to make way for a measurement`));
    }
  }
  return out;
}

/** Claude に見せる 1 行 @param {string[]} reasons @returns {string} */
export function environmentalNote(reasons) {
  return t(
    `[switchyard] この失敗はコードのせいではないかもしれない: ${reasons.join('・')}。コードを直す前に、機械が空いてから同じコマンドを走らせ直して確かめる(switchyard top で混み具合が見える)`,
    `[switchyard] this failure may not be caused by the code: ${reasons.join('; ')}. Before changing code, re-run the same command when the machine is quiet to check (switchyard top shows how busy it is)`,
  );
}
