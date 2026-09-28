/**
 * Auto-paging helpers for list endpoints that cap each response.
 */

export interface PaginateOffsetOptions {
  /** Items requested per page. */
  pageSize: number;
  /** Keys used to de-duplicate items across pages (first present wins). */
  idKeys?: readonly string[];
  /** Stop after yielding this many items (default 10000). */
  maxItems?: number;
}

function itemId(item: unknown, idKeys: readonly string[]): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  for (const key of idKeys) {
    const v = (item as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return undefined;
}

/**
 * Iterate a `limit`/`offset` list until a short or empty page. Items already
 * seen (by `_id`/`id`) are skipped, since newest-first ordering can shift
 * while paging.
 */
export async function* paginateOffset<T>(
  fetchPage: (limit: number, offset: number) => Promise<T[]>,
  options: PaginateOffsetOptions,
): AsyncGenerator<T, void, undefined> {
  const { pageSize } = options;
  const idKeys = options.idKeys ?? ["_id", "id"];
  const maxItems = options.maxItems ?? 10_000;
  const seen = new Set<string>();
  let offset = 0;
  let yielded = 0;
  for (;;) {
    const items = await fetchPage(pageSize, offset);
    if (!Array.isArray(items) || items.length === 0) return;
    for (const item of items) {
      const id = itemId(item, idKeys);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      yield item;
      yielded += 1;
      if (yielded >= maxItems) return;
    }
    if (items.length < pageSize) return;
    offset += items.length;
  }
}

export interface PaginatePagesOptions {
  /** Items per page. */
  limit: number;
  /** Envelope key holding the page's items (e.g. `stores`). */
  itemsKey: string;
  /** Envelope key holding the total count (default `total`). */
  totalKey?: string;
  /** Stop after yielding this many items (default 10000). */
  maxItems?: number;
}

/**
 * Iterate a `page`/`limit` list with a `{items, total}` envelope, stopping
 * when `page * limit >= total` or a page is empty.
 */
export async function* paginatePages<T>(
  fetchPage: (page: number, limit: number) => Promise<Record<string, unknown>>,
  options: PaginatePagesOptions,
): AsyncGenerator<T, void, undefined> {
  const { limit, itemsKey } = options;
  const totalKey = options.totalKey ?? "total";
  const maxItems = options.maxItems ?? 10_000;
  let yielded = 0;
  for (let page = 1; ; page += 1) {
    const envelope = await fetchPage(page, limit);
    const items = envelope && Array.isArray(envelope[itemsKey]) ? (envelope[itemsKey] as T[]) : [];
    if (items.length === 0) return;
    for (const item of items) {
      yield item;
      yielded += 1;
      if (yielded >= maxItems) return;
    }
    const total = Number(envelope[totalKey]);
    if (Number.isFinite(total) && page * limit >= total) return;
    if (!Number.isFinite(total) && items.length < limit) return;
  }
}

/** Collect an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
