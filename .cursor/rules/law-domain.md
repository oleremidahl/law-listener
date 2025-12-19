---
description: Domain knowledge about Norwegian laws and XML structures
globs: src/**/*.rs, scripts/**/*.py
---

# Norwegian Law Domain Knowledge

## XML Structure Reference
When parsing XML files from Lovdata/Stortinget, look for these specific paths based on the project samples:

- **Document ID:** Found in `dl.data-document-key-info > dd.dokid` (e.g., `NL/lov/1884-06-14-3`).
- **Legacy ID:** Found in `dl.data-document-key-info > dd.legacyID` (e.g., `LOV-1884-06-14-3`).
- **Short Title:** Found in `dl.data-document-key-info > dd.titleShort`.
- **Change Detection:** A law is an "Amendment Law" (endringslov) if it contains `<dt class="changesToDocuments">`.
- **Relationship:** Amendments link to base laws via `changesToDocuments > ul > li > a[href]`.

## Workflow
1. **Stortinget (RSS):** Issues "Lovvedtak". Status: `vedtatt`.
2. **Lovdata (LTI RSS):** Issues sanksjonert law. Status: `sanksjonert`.
3. **Commencement:** Look for "I kraft fra" or "Ikrafttredelse" in the feed or XML.