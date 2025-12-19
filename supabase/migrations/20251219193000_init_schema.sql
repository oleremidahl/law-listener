-- Enable gen_random_uuid()
create extension if not exists pgcrypto;

-- Enums (guarded)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'legal_document_type') then
    create type legal_document_type as enum ('lov', 'forskrift_sentral', 'forskrift_lokal');
  end if;

  if not exists (select 1 from pg_type where typname = 'law_proposal_status') then
    create type law_proposal_status as enum ('vedtatt', 'sanksjonert', 'i_kraft');
  end if;
end $$;

-- legal_documents
create table if not exists public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  dokid text unique not null,
  legacy_id text,
  title text not null,
  short_title text,
  document_type legal_document_type not null,
  created_at timestamptz default now()
);

-- law_proposals
create table if not exists public.law_proposals (
  id uuid primary key default gen_random_uuid(),
  stortinget_id text unique,
  title text not null,
  status law_proposal_status not null default 'vedtatt'::law_proposal_status,
  stortinget_link text,
  lovdata_link text,
  decision_date date,
  enforcement_date text,
  feed_description text,
  created_at timestamptz default now()
);

-- proposal_targets
create table if not exists public.proposal_targets (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid references public.law_proposals(id) on delete cascade,
  document_id uuid references public.legal_documents(id) on delete cascade,
  unique (proposal_id, document_id)
);
