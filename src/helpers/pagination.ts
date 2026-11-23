export type Cursor = string | null | undefined;
export type PageFetcher<T> = (cursor: Cursor, amount: number) => Promise<[T[], Cursor]>;

export async function* iterPaginated<T>(
  fetchPage: PageFetcher<T>,
  amount = 0,
  pageSize = 0,
  initialCursor: Cursor = null,
  options: { itemKey?: (item: T) => unknown } = {},
): AsyncGenerator<T> {
  amount = Math.trunc(Number(amount));
  pageSize = Math.trunc(Number(pageSize));
  let cursor = initialCursor;
  let yielded = 0;
  const seen = new Set<unknown>();
  while (true) {
    let pageAmount = pageSize;
    if (amount) {
      const remaining = amount - yielded;
      if (remaining <= 0) return;
      pageAmount = pageSize ? Math.min(pageSize, remaining) : remaining;
    }
    const [items, nextCursor] = await fetchPage(cursor, pageAmount);
    if (!items || !items.length) return;
    for (const item of items) {
      if (amount && yielded >= amount) return;
      if (options.itemKey) {
        const key = options.itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      yield item;
      yielded += 1;
    }
    if (!nextCursor || nextCursor === cursor) return;
    cursor = nextCursor;
  }
}

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
