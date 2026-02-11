import { ProposalDetailView } from "@/components/proposals/proposal-detail-view"

type PageProps = {
  params: Promise<{ id: string }>
}

export default async function ProposalPage({ params }: PageProps) {
  const { id } = await params

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-10 md:px-8 md:py-14">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-0 left-0 h-80 w-80 rounded-full bg-sky-200/35 blur-3xl" />
        <div className="absolute right-0 bottom-10 h-80 w-80 rounded-full bg-amber-200/45 blur-3xl" />
      </div>

      <div className="mx-auto w-full max-w-5xl">
        <ProposalDetailView proposalId={id} />
      </div>
    </main>
  )
}
