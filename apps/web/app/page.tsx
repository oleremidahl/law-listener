import { Suspense } from "react"

import { ProposalListView } from "@/components/proposals/proposal-list-view"

function ListFallback() {
  return (
    <div className="rounded-xl border border-zinc-300/90 bg-white/90 p-6 text-sm text-zinc-600">
      Laster lovforslag...
    </div>
  )
}

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-10 md:px-8 md:py-14">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-0 left-0 h-72 w-72 rounded-full bg-sky-200/35 blur-3xl" />
        <div className="absolute right-0 bottom-10 h-80 w-80 rounded-full bg-amber-200/45 blur-3xl" />
      </div>

      <div className="mx-auto w-full max-w-6xl space-y-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold tracking-[0.16em] text-zinc-600 uppercase">
            Law Listener
          </p>
          <h1 className="font-serif text-4xl leading-tight text-zinc-950 md:text-5xl">
            Oversikt over lovbeslutninger i Stortinget
          </h1>
          <p className="max-w-3xl text-base leading-relaxed text-zinc-700">
            Et lesbart kontrollpanel for nye lovbeslutninger, med filtrering, detaljer
            og koblinger til relevante lover.
          </p>
        </header>

        <Suspense fallback={<ListFallback />}>
          <ProposalListView />
        </Suspense>
      </div>
    </main>
  )
}
