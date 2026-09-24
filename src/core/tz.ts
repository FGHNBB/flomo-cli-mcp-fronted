/**
 * flomo 的 tz 参数是「小时:分钟」形式的时区偏移（抓包实测：东八区为 "8:0"）。
 * JS 的 getTimezoneOffset() 返回的是「UTC 减本地」的分钟数，因此需要取反。
 */
export function localTzOffset(now: Date = new Date()): string {
  const minutesEast = -now.getTimezoneOffset();
  const sign = minutesEast < 0 ? '-' : '';
  const abs = Math.abs(minutesEast);
  return `${sign}${Math.floor(abs / 60)}:${abs % 60}`;
}
