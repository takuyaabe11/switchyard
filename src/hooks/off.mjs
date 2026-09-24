// @ts-check
/**
 * switchyard を止めているか。SWITCHYARD_OFF=1(以前の名前 SWITCHYARD_THINKER=1 も同じ)で、hook は何もせず、shim は本物をそのまま走らせる。
 * @param {NodeJS.ProcessEnv} env @returns {boolean}
 */
export const isOff = (env) => env.SWITCHYARD_OFF === '1' || env.SWITCHYARD_THINKER === '1';
