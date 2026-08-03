export type Page<T> = Readonly<{ items: readonly T[]; nextToken?: string }>;

export type Collected<T> = Readonly<{
  items: readonly T[];
  /** 翻到上限仍未看完。此时"没找到"只代表没看全，不代表不存在。 */
  truncated: boolean;
  pages: number;
}>;

const DEFAULT_MAX_PAGES = 10;

/**
 * 翻页直到取完或触顶。
 *
 * 只取第一页会静默给出偏小的答案——漏掉正在 ALARM 的告警、漏掉有堆积的
 * 队列。这比直接报错危险得多：报错会让人去查，而偏小的答案会被当成结论。
 *
 * 所以触顶时不是悄悄返回，而是把 truncated 标出来，让调用方有机会说明
 * "这个结果不完整"。
 */
export const collectPages = async <T>(
  fetchPage: (token: string | undefined) => Promise<Page<T>>,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<Collected<T>> => {
  const items: T[] = [];
  let token: string | undefined;
  let pages = 0;

  do {
    const page = await fetchPage(token);
    items.push(...page.items);
    token = page.nextToken;
    pages += 1;
  } while (token && pages < maxPages);

  return { items, truncated: Boolean(token), pages };
};
