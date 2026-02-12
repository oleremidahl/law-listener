import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="space-y-4 text-center">
        <h1 className="font-serif text-4xl text-zinc-900">Fant ikke siden</h1>
        <p className="text-zinc-600">Kontroller lenken, eller gå tilbake til oversikten.</p>
        <Button asChild>
          <Link href="/">Til lovoversikt</Link>
        </Button>
      </div>
    </main>
  )
}
