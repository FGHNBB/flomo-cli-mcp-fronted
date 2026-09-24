import { describe, expect, it } from 'vitest';
import { localTzOffset } from '../src/core/tz';

/** 只依赖 getTimezoneOffset()，用假对象即可稳定测试。 */
function fakeDate(offsetMinutes: number): Date {
  return { getTimezoneOffset: () => offsetMinutes } as Date;
}

describe('localTzOffset', () => {
  it('东八区输出 8:0（与抓包一致）', () => {
    expect(localTzOffset(fakeDate(-480))).toBe('8:0');
  });

  it('UTC 输出 0:0', () => {
    expect(localTzOffset(fakeDate(0))).toBe('0:0');
  });

  it('半小时时区输出 -5:30', () => {
    expect(localTzOffset(fakeDate(330))).toBe('-5:30');
  });

  it('带分钟的东侧偏移输出 5:45', () => {
    expect(localTzOffset(fakeDate(-345))).toBe('5:45');
  });
});
