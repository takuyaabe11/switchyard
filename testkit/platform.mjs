// @ts-check
// テストの、Windows と POSIX の違い。
export const WIN = process.platform === 'win32';

/**
 * POSIX にしか無い仕組み(プロセスグループ・信号・/bin/sh・実行の権限の印)を確かめるテストに付ける skip の値。
 * Windows で弱まる機能は README の「Windows」に書き、Windows の通しは test/windows.test.mjs が見る。
 */
export const POSIX_ONLY = WIN ? 'POSIX だけの仕組み(プロセスグループ・信号・/bin/sh・実行の権限)を見るテスト' : false;

/** sh の場所。Windows は PATH の sh(Git for Windows) */
export const SH_BIN = WIN ? 'sh' : '/bin/sh';

/** 最小の PATH。Windows は呼び出し元の PATH(Git の usr\bin を含む)をそのまま使う @param {string} posix */
export const basePath = (posix) => (WIN ? (process.env.PATH ?? '') : posix);
