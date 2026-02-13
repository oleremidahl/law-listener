-- Enforce least-privilege access for proposal summaries.
-- Public clients can read summaries, but write paths are restricted to service_role.

alter table public.proposal_summaries enable row level security;

-- Normalize policies so manual policy drift does not keep broader access in place.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'proposal_summaries'
  loop
    execute format(
      'drop policy if exists %I on public.proposal_summaries',
      policy_row.policyname
    );
  end loop;
end $$;

create policy proposal_summaries_select
on public.proposal_summaries
for select
to anon, authenticated
using (true);

-- Restrict direct table writes from public roles.
revoke insert, update, delete on table public.proposal_summaries from anon, authenticated;
grant select on table public.proposal_summaries to anon, authenticated;

-- Lock down security-definer claim RPC to service_role only.
revoke all
on function public.claim_proposal_summary_generation(
  uuid,
  law_proposal_status,
  integer,
  integer,
  text,
  text
)
from public, anon, authenticated;

grant execute
on function public.claim_proposal_summary_generation(
  uuid,
  law_proposal_status,
  integer,
  integer,
  text,
  text
)
to service_role;
