/*
 * 时间工具。
 *
 * 存储层永远是「秒（浮点）」，只有展示时才格式化成 m:ss / h:mm:ss。
 * 这样播放器给什么单位都只在一个地方换算，不会让同一个时间在两种单位之间来回漂。
 */
(function () {
  'use strict';

  const PRN = (globalThis.PRN = globalThis.PRN || {});

  /** 5412.4 -> "1:30:12"；754.2 -> "12:34"；非法值 -> "--:--" */
  function formatTime(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds + 1e-6);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + ss;
    return m + ':' + ss;
  }

  /**
   * 把播放器返回的原始时间换算成秒。
   *
   * getPlayTime() 的单位没有任何文档说明，可能毫秒也可能秒，必须运行时判定：
   *  - 能拿到时长时，用「谁更接近时长」来判（换算完的秒数应该 <= 时长）；
   *  - 拿不到时长时，退化成「谁更接近 0–4.5 小时的合理区间」。
   * 原始值不做任何丢弃，调试区会把它原样打出来，方便对着看。
   */
  function normalizePlayTime(raw, durationSec) {
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) return { seconds: NaN, unit: 'unknown' };

    const asSeconds = num;
    const asMs = num / 1000;
    let unit = 's';

    if (Number.isFinite(durationSec) && durationSec > 0) {
      // 文档给出的比例校验：离时长更近的那个解释胜出
      if (Math.abs(asSeconds - durationSec) < Math.abs(asMs - durationSec)) unit = 's';
      else unit = 'ms';
    } else {
      // 没有时长可参照时的退化判定
      const plausibleMax = 4.5 * 3600;
      const secOk = asSeconds <= plausibleMax;
      const msOk = asMs <= plausibleMax;
      unit = !secOk && msOk ? 'ms' : 's';
    }

    return { seconds: unit === 'ms' ? asMs : asSeconds, unit };
  }

  PRN.time = { formatTime, normalizePlayTime };
})();
