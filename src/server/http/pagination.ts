export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export function toSkipTake({ page, pageSize }: { page: number; pageSize: number }) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function toPage<T>(
  items: T[],
  total: number,
  { page, pageSize }: { page: number; pageSize: number },
): Page<T> {
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
