---
description: Core project standards and tech stack for Norwegian Law Tracker
globs: **/*
---

# Project: Norwegian Law Tracker (MVP)
# Tech Stack: Rust, Cloudflare Workers (workers-rs), Supabase (Postgres)

## Coding Standards
- Use `quick-xml` for parsing (crucial for Cloudflare Workers' 10ms CPU limit).
- Prefer `serde` for data transformation.
- Database access via Supabase REST API or `postgrest-rs`.

## Naming Conventions
- Use English for code, variables, and documentation.
- Keep original Norwegian names for law titles (e.g., "Folketrygdloven") to ensure database matching.

## Database Schema (Current)
Refer to the following tables in Supabase:
- `legal_documents`: Base laws (the "foundation").
- `law_proposals`: Tracking law decisions (vedtak) from Stortinget to Lovdata.
- `proposal_targets`: Junction table for many-to-many relationship between proposals and laws.
- WARNING: This schema is for context only and is not meant to be run.
- Table order and constraints may not be valid for execution.

CREATE TABLE public.law_proposals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stortinget_id text UNIQUE,
  title text NOT NULL,
  status USER-DEFINED NOT NULL DEFAULT 'vedtatt'::law_proposal_status,
  stortinget_link text,
  lovdata_link text,
  decision_date date,
  enforcement_date text,
  feed_description text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT law_proposals_pkey PRIMARY KEY (id)
);
CREATE TABLE public.legal_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  dokid text NOT NULL UNIQUE,
  legacy_id text,
  title text NOT NULL,
  short_title text,
  document_type USER-DEFINED NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT legal_documents_pkey PRIMARY KEY (id)
);
CREATE TABLE public.proposal_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  proposal_id uuid,
  document_id uuid,
  CONSTRAINT proposal_targets_pkey PRIMARY KEY (id),
  CONSTRAINT proposal_targets_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.law_proposals(id),
  CONSTRAINT proposal_targets_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.legal_documents(id)
);

## Future Work
If we decide to add another worker that introduces a possibility of overlapping scheduled runs, remind me to add a lock (DB advisory lock or similar). 