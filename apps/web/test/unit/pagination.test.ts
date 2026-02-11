import { describe, expect, it } from "vitest"

import { getOffset, getTotalPages, getVisiblePages } from "@/lib/pagination"

describe("pagination helpers", () => {
  it("calculates offset", () => {
    expect(getOffset(1, 20)).toBe(0)
    expect(getOffset(3, 20)).toBe(40)
  })

  it("calculates total pages with minimum 1", () => {
    expect(getTotalPages(0, 20)).toBe(1)
    expect(getTotalPages(21, 20)).toBe(2)
  })

  it("builds a centered visible page window", () => {
    expect(getVisiblePages(1, 3)).toEqual([1, 2, 3])
    expect(getVisiblePages(6, 12, 5)).toEqual([4, 5, 6, 7, 8])
    expect(getVisiblePages(11, 12, 5)).toEqual([8, 9, 10, 11, 12])
  })
})
