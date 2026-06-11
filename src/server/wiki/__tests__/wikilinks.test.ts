import { describe, expect, it } from 'vitest';
import {
  extractWikiLinks,
  resolveWikiLinkTarget,
  normalizeWikiLink,
  type ExtractedLink,
} from '../wikilinks';

// 实现疑点（仅记录，不修改被测代码）：
// 1. titleResolver 对带 `subject:` 前缀的跨主题链接同样会被调用（传入的是去前缀后的
//    rawTitle）。这意味着"本 subject 的 title→slug 映射"可能被错误地套用到其他
//    subject 的页面标题上。本文件按当前实际行为断言。
// 2. `target = titleResolver?.(rawTitle) ?? normalizeSlug(rawTitle)` 使用 `??`，
//    若 resolver 返回空字符串 ''，不会回退到 normalizeSlug，而是整条链接被丢弃
//    （`if (target === '') continue`）。resolver 想表达"未命中"必须返回 undefined。
// 3. maskCodeBlocks 用等长空格替换 code fence / 行内 code，position 偏移量不受影响；
//    但未闭合的 ``` fence 不会被屏蔽（regex 要求成对），此处不另行断言。

describe('extractWikiLinks — 基础语法', () => {
  it('解析 [[Target]]', () => {
    const links = extractWikiLinks('see [[TypeScript]] here');
    expect(links).toHaveLength(1);
    const link = links[0];
    expect(link.raw).toBe('[[TypeScript]]');
    expect(link.rawTitle).toBe('TypeScript');
    expect(link.target).toBe('typescript');
    expect(link.targetSubjectSlug).toBe(''); // 未提供 currentSubjectSlug 时为空串
    expect(link.alias).toBeNull();
    expect(link.position).toEqual({ start: 4, end: 18 });
  });

  it('解析 [[Target|Alias]]', () => {
    const [link] = extractWikiLinks('[[Page Name|显示别名]]');
    expect(link.rawTitle).toBe('Page Name');
    expect(link.target).toBe('page-name');
    expect(link.alias).toBe('显示别名');
  });

  it('解析 [[Target#Section]] —— 丢弃 section 锚点', () => {
    const [link] = extractWikiLinks('[[Page Name#Some Section]]');
    expect(link.rawTitle).toBe('Page Name');
    expect(link.target).toBe('page-name');
    expect(link.alias).toBeNull();
  });

  it('解析 [[Target#Section|Alias]]', () => {
    const [link] = extractWikiLinks('[[Page Name#Sec|alias text]]');
    expect(link.rawTitle).toBe('Page Name');
    expect(link.target).toBe('page-name');
    expect(link.alias).toBe('alias text');
  });

  it('alias 为空白时归一化为 null', () => {
    const [link] = extractWikiLinks('[[Page|   ]]');
    expect(link.alias).toBeNull();
  });
});

describe('extractWikiLinks — 跨主题 subject 前缀', () => {
  it('解析 [[other-subject:Page]]', () => {
    const [link] = extractWikiLinks('[[other-subject:Page Title]]', {
      currentSubjectSlug: 'general',
    });
    expect(link.targetSubjectSlug).toBe('other-subject');
    expect(link.rawTitle).toBe('Page Title');
    expect(link.target).toBe('page-title');
  });

  it('解析 [[other-subject:page-slug|Alias]]', () => {
    const [link] = extractWikiLinks('[[other-subject:page-slug|别名]]', {
      currentSubjectSlug: 'general',
    });
    expect(link.targetSubjectSlug).toBe('other-subject');
    expect(link.target).toBe('page-slug');
    expect(link.alias).toBe('别名');
  });

  it('跨主题 + section 锚点', () => {
    const [link] = extractWikiLinks('[[math:Calculus#Limits]]');
    expect(link.targetSubjectSlug).toBe('math');
    expect(link.target).toBe('calculus');
  });

  it('前缀不符合 slug 正则时按本 subject 的完整 title 处理（[[My Note: draft]]）', () => {
    const [link] = extractWikiLinks('[[My Note: draft]]', {
      currentSubjectSlug: 'general',
    });
    expect(link.targetSubjectSlug).toBe('general'); // 未拆分前缀
    expect(link.rawTitle).toBe('My Note: draft');
    expect(link.target).toBe('my-note-draft'); // 冒号被 normalizeSlug 剥除
  });

  it('无前缀链接回落到 currentSubjectSlug', () => {
    const [link] = extractWikiLinks('[[Foo]]', { currentSubjectSlug: 'prog' });
    expect(link.targetSubjectSlug).toBe('prog');
  });
});

describe('extractWikiLinks — titleResolver', () => {
  it('resolver 命中时使用其返回的 slug', () => {
    const [link] = extractWikiLinks('[[My Fancy Title]]', {
      titleResolver: (t) => (t === 'My Fancy Title' ? 'actual-slug' : undefined),
    });
    expect(link.target).toBe('actual-slug');
  });

  it('resolver 未命中（返回 undefined）时回退 normalizeSlug', () => {
    const [link] = extractWikiLinks('[[Some Page]]', {
      titleResolver: () => undefined,
    });
    expect(link.target).toBe('some-page');
  });

  it('当前行为：resolver 返回空串时链接被丢弃（不回退，见文件顶部疑点 2）', () => {
    const links = extractWikiLinks('[[Some Page]]', {
      titleResolver: () => '',
    });
    expect(links).toHaveLength(0);
  });

  it('当前行为：跨主题链接也会调用 titleResolver（见文件顶部疑点 1）', () => {
    const seen: string[] = [];
    const [link] = extractWikiLinks('[[other:Remote Title]]', {
      currentSubjectSlug: 'general',
      titleResolver: (t) => {
        seen.push(t);
        return 'local-mapped';
      },
    });
    expect(seen).toEqual(['Remote Title']);
    expect(link.target).toBe('local-mapped');
    expect(link.targetSubjectSlug).toBe('other');
  });

  it('兼容旧签名 (md, resolver)', () => {
    const [link] = extractWikiLinks('[[Old Style]]', () => 'legacy-slug');
    expect(link.target).toBe('legacy-slug');
    expect(link.targetSubjectSlug).toBe(''); // 旧签名无 currentSubjectSlug
  });
});

describe('extractWikiLinks — CJK 与多链接', () => {
  it('CJK 标题保留 Unicode 字符', () => {
    const [link] = extractWikiLinks('[[中文页面 标题]]');
    expect(link.rawTitle).toBe('中文页面 标题');
    expect(link.target).toBe('中文页面-标题');
  });

  it('一段 markdown 中的多条链接按出现顺序返回，position 准确', () => {
    const md = '[[A]] then [[B|b]] and [[s:C]]';
    const links = extractWikiLinks(md, { currentSubjectSlug: 'general' });
    expect(links.map((l) => l.target)).toEqual(['a', 'b', 'c']);
    expect(links.map((l) => l.targetSubjectSlug)).toEqual(['general', 'general', 's']);
    for (const l of links) {
      expect(md.slice(l.position.start, l.position.end)).toBe(l.raw);
    }
  });
});

describe('extractWikiLinks — 代码块屏蔽', () => {
  it('围栏代码块中的链接被忽略，块外链接位置不受影响', () => {
    const md = '```\n[[Inside Fence]]\n```\n[[Outside]]';
    const links = extractWikiLinks(md);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('outside');
    expect(md.slice(links[0].position.start, links[0].position.end)).toBe('[[Outside]]');
  });

  it('行内 code 中的链接被忽略', () => {
    const links = extractWikiLinks('use `[[Not A Link]]` but [[Real]]');
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe('real');
  });
});

describe('extractWikiLinks — 边界情况', () => {
  it('空字符串返回空数组', () => {
    expect(extractWikiLinks('')).toEqual([]);
  });

  it('无链接的 markdown 返回空数组', () => {
    expect(extractWikiLinks('# 标题\n\n普通段落，没有链接。')).toEqual([]);
  });

  it('标题归一化后为空（如纯标点）的链接被丢弃', () => {
    expect(extractWikiLinks('[[!!!]]')).toEqual([]);
  });

  it('返回值满足 ExtractedLink 字段契约', () => {
    const [link] = extractWikiLinks('[[X]]');
    const keys: (keyof ExtractedLink)[] = [
      'raw',
      'rawTitle',
      'target',
      'targetSubjectSlug',
      'alias',
      'position',
    ];
    for (const k of keys) expect(link).toHaveProperty(k);
  });
});

describe('resolveWikiLinkTarget', () => {
  it('解析纯标题', () => {
    expect(resolveWikiLinkTarget('Page Name', 'general')).toEqual({
      subjectSlug: 'general',
      slug: 'page-name',
    });
  });

  it('解析带 subject 前缀 + alias + section', () => {
    expect(resolveWikiLinkTarget('other:Page#Sec|alias', 'general')).toEqual({
      subjectSlug: 'other',
      slug: 'page',
    });
  });

  it('缺省 currentSubjectSlug 时 subjectSlug 为空串', () => {
    expect(resolveWikiLinkTarget('Page')).toEqual({ subjectSlug: '', slug: 'page' });
  });

  it('非法前缀（含大写/空格）不当作 subject', () => {
    expect(resolveWikiLinkTarget('My Note: draft', 'general')).toEqual({
      subjectSlug: 'general',
      slug: 'my-note-draft',
    });
  });
});

describe('normalizeWikiLink', () => {
  it('剥除 subject 前缀、alias 与 section，输出归一化 slug', () => {
    expect(normalizeWikiLink('other:Page Title#Sec|alias')).toBe('page-title');
    expect(normalizeWikiLink('Simple Title')).toBe('simple-title');
    expect(normalizeWikiLink('中文 标题')).toBe('中文-标题');
  });
});
