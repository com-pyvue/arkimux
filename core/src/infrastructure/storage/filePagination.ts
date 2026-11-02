import type { Page, PageQuery } from "../../application/platformStore.ts";

export function pageByKey<T>(
  items: readonly T[],
  key: (item: T) => string,
  query: PageQuery = {},
): Page<T> {
  const pageSize = query.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error("Page size must be an integer from 1 to 500.");
  }
  const ordered = [...items].sort((left, right) => key(left).localeCompare(key(right)));
  let start = 0;
  if (query.cursor !== undefined) {
    const cursorIndex = ordered.findIndex((item) => key(item) === query.cursor);
    if (cursorIndex < 0) throw new Error("Page cursor is invalid.");
    start = cursorIndex + 1;
  }
  const pageItems = ordered.slice(start, start + pageSize);
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    ...(last !== undefined && start + pageItems.length < ordered.length
      ? { nextCursor: key(last) }
      : {}),
  };
}
