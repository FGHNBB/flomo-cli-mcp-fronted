import { describe, expect, it } from 'vitest';
import { buildSignSource, calculateSign, ksort, md5 } from '../src/core/sign';

describe('md5', () => {
  it('与已知向量一致', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});

describe('ksort', () => {
  it('按 key 升序重排', () => {
    expect(Object.keys(ksort({ b: 2, a: 1, C: 3 }))).toEqual(['C', 'a', 'b']);
  });

  it('整数型 key 保持数值升序：与网页端写回普通对象的行为一致', () => {
    expect(Object.keys(ksort({ 10: 'x', 2: 'y', a: 'z' }))).toEqual(['2', '10', 'a']);
  });
});

describe('buildSignSource', () => {
  it('按 key 排序后拼成 k=v& 形式', () => {
    expect(buildSignSource({ b: '2', a: '1' })).toBe('a=1&b=2');
  });

  it('跳过空串/false/null/undefined，保留数字 0', () => {
    expect(
      buildSignSource({ a: '', b: false, c: null, d: undefined, e: 0, f: true }),
    ).toBe('e=0&f=true');
  });

  it('数组排序后展开为 key[]', () => {
    expect(buildSignSource({ tag: ['c', 'a', 'b'] })).toBe('tag[]=a&tag[]=b&tag[]=c');
  });

  it('全部可跳过时返回空串', () => {
    expect(buildSignSource({ a: '', b: null })).toBe('');
  });
});

describe('calculateSign', () => {
  it('等价于 md5(拼接串 + 盐值)', () => {
    expect(calculateSign({ b: '2', a: '1' }, 'SALT')).toBe(md5('a=1&b=2SALT'));
  });
});
