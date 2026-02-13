import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getLovdataLinkFromDokid(dokid: string): string {
  return `https://lovdata.no/dokument/${dokid}`
}
