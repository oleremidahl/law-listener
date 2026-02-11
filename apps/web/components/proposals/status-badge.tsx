import { Badge } from "@/components/ui/badge"
import type { ProposalStatus } from "@/lib/types"

const labelByStatus: Record<ProposalStatus, string> = {
  vedtatt: "Vedtatt",
  sanksjonert: "Sanksjonert",
  i_kraft: "I kraft",
}

const classByStatus: Record<ProposalStatus, string> = {
  vedtatt: "bg-sky-100 text-sky-900 border-sky-200",
  sanksjonert: "bg-amber-100 text-amber-900 border-amber-200",
  i_kraft: "bg-emerald-100 text-emerald-900 border-emerald-200",
}

export function getStatusLabel(status: ProposalStatus): string {
  return labelByStatus[status]
}

export function StatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <Badge variant="outline" className={classByStatus[status]}>
      {labelByStatus[status]}
    </Badge>
  )
}
