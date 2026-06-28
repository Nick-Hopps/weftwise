import { describe, it, expect } from 'vitest';
import {
  normalizeSlug,
  normalizeSubjectSlug,
  sanitizeSubjectSlugInput,
  SUBJECT_SLUG_RE,
  MAX_SUBJECT_SLUG_LENGTH,
} from '../slug';

describe('normalizeSlug（页面 slug，Unicode-aware）', () => {
  it('保留 CJK 字符', () => {
    expect(normalizeSlug('日本語課程')).toBe('日本語課程');
  });

  it('空格转连字符并小写', () => {
    expect(normalizeSlug('Hello World')).toBe('hello-world');
  });

  it('剥离标点与符号', () => {
    expect(normalizeSlug('Foo: Bar! (baz)')).toBe('foo-bar-baz');
  });

  it('折叠连续连字符并修剪段首尾', () => {
    expect(normalizeSlug('--a--b--/--c--')).toBe('a-b/c');
  });

  it('全符号输入产生空串', () => {
    expect(normalizeSlug('!!!')).toBe('');
  });
});

describe('normalizeSubjectSlug（主题 slug，强制 ASCII）', () => {
  it('普通英文名称', () => {
    expect(normalizeSubjectSlug('Frontend Architecture')).toBe('frontend-architecture');
  });

  it('产物总是匹配 SUBJECT_SLUG_RE（或为空）', () => {
    for (const input of ['Hello World', 'a_b.c', '  X  ', '123 go']) {
      const slug = normalizeSubjectSlug(input);
      expect(slug === '' || SUBJECT_SLUG_RE.test(slug)).toBe(true);
    }
  });

  it('CJK 名称产生空串（需要用户手填 slug）', () => {
    expect(normalizeSubjectSlug('日本語課程')).toBe('');
  });

  it('截断到最大长度', () => {
    const slug = normalizeSubjectSlug('a'.repeat(100));
    expect(slug.length).toBe(MAX_SUBJECT_SLUG_LENGTH);
  });

  it('修剪首尾连字符', () => {
    expect(normalizeSubjectSlug('--hello--')).toBe('hello');
  });
});

describe('sanitizeSubjectSlugInput（输入态宽松规范化）', () => {
  it('保留末尾连字符以便用户继续输入', () => {
    // 这是本次修复的核心：normalizeSubjectSlug 会把末尾 `-` 吃掉导致无法输入横杠。
    expect(sanitizeSubjectSlugInput('frontend-')).toBe('frontend-');
  });

  it('允许在词中输入连字符', () => {
    expect(sanitizeSubjectSlugInput('frontend-architecture')).toBe('frontend-architecture');
  });

  it('转小写并把非法字符（空格/符号）换成连字符', () => {
    expect(sanitizeSubjectSlugInput('Foo Bar!')).toBe('foo-bar-');
  });

  it('剥离前导连字符（满足 SUBJECT_SLUG_RE 的 ^[a-z0-9]）', () => {
    expect(sanitizeSubjectSlugInput('-abc')).toBe('abc');
  });

  it('截断到最大长度', () => {
    expect(sanitizeSubjectSlugInput('a'.repeat(100)).length).toBe(MAX_SUBJECT_SLUG_LENGTH);
  });

  it('其产物经 normalizeSubjectSlug 收口后总是合法（或为空）', () => {
    for (const input of ['frontend-', 'Foo Bar!', 'a--b', '-x-', '中文-en']) {
      const finalized = normalizeSubjectSlug(sanitizeSubjectSlugInput(input));
      expect(finalized === '' || SUBJECT_SLUG_RE.test(finalized)).toBe(true);
    }
  });
});

describe('SUBJECT_SLUG_RE', () => {
  it('接受 kebab-case', () => {
    expect(SUBJECT_SLUG_RE.test('general')).toBe(true);
    expect(SUBJECT_SLUG_RE.test('my-subject-2')).toBe(true);
  });

  it('拒绝大写、下划线、前导连字符与非 ASCII', () => {
    expect(SUBJECT_SLUG_RE.test('My-Subject')).toBe(false);
    expect(SUBJECT_SLUG_RE.test('a_b')).toBe(false);
    expect(SUBJECT_SLUG_RE.test('-abc')).toBe(false);
    expect(SUBJECT_SLUG_RE.test('日本語')).toBe(false);
  });
});
