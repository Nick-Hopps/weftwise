/** 该路径是否值得作为 subject 的"上次页面"记忆（subject 专属、跨主题会 404 的路由）。*/
export function isRememberablePath(pathname: string): boolean {
  return pathname.startsWith('/wiki/') || pathname.startsWith('/sources/');
}

/** 给路径合并 `?s=<slug>`：删除原有 s、保留其余 query 与 hash、s 追加到末尾。*/
export function withSubjectParam(path: string, slug: string): string {
  const [pathAndQuery, hash = ''] = path.split('#');
  const [pathname, query = ''] = pathAndQuery.split('?');
  const params = new URLSearchParams(query);
  params.delete('s');
  params.append('s', slug);
  return `${pathname}?${params.toString()}${hash ? `#${hash}` : ''}`;
}
