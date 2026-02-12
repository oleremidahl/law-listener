export function getOffset(page: number, pageSize: number): number {
  return Math.max(0, (page - 1) * pageSize)
}

export function getTotalPages(totalCount: number, pageSize: number): number {
  if (totalCount <= 0) {
    return 1
  }

  return Math.max(1, Math.ceil(totalCount / pageSize))
}

export function getVisiblePages(
  currentPage: number,
  totalPages: number,
  maxVisible = 5
): number[] {
  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, index) => index + 1)
  }

  const half = Math.floor(maxVisible / 2)
  let start = Math.max(1, currentPage - half)
  const end = Math.min(totalPages, start + maxVisible - 1)

  if (end - start + 1 < maxVisible) {
    start = Math.max(1, end - maxVisible + 1)
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}
