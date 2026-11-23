# Document management (brief §9)

Built 22-Nov-2026 (IST). Flag: `rbac_v2_support` (OFF). Migration 0173. Screen: the Documents panel of the shop workbench (/staff/support/shop/{shopId}).

| Requirement | Built as |
|---|---|
| Types: GST, PAN, Shop Act, FSSAI and other licences, catalogues, images, specifications, price lists, shop photos, agreements, other | `staff_documents.doc_type` (14 values) |
| Upload / download, categorisation, shop and product association | `staff_documents` (shop, optional shop product, type, title, ticket) |
| Version history — new versions never overwrite old | `staff_document_versions` (version n+1 per upload); UPDATE refused by trigger `staff_document_versions_immutable` |
| Uploaded by / at (IST shown) | `uploaded_by`, `uploaded_at`; audit `staff_document.uploaded` with SHA-256 |
| Verification status | UNVERIFIED → VERIFIED / REJECTED by a Support Manager or admin; a new version resets it to UNVERIFIED |
| Role-based access | add: Support User (shops of tickets assigned to them), Support / Operations managers, Operations User (shops they onboarded), admin; see: those plus the shop owner |
| Secure storage, signed time-limited links | bytes in the database (as the existing shop documents); download only via an HMAC-signed link valid 10 minutes (`/api/staff/documents/{id}/link` → `/api/staff/documents/file?t=…`), served as an attachment, `no-store`, `nosniff`; each link issued is audited |
| No hard deletion below Admin; Admin deletion needs two Admins | delete = `DOCUMENT_DELETE` approval raised by an admin, approved by a different admin; then the versions' bytes are removed and the document row stays as a DELETED record |
| File types and size as the existing upload service; virus / type validation | type read from the bytes (PDF, JPEG, PNG, WebP; CSV / XLSX by content + name for price lists), size ≤ rule `documentUpload.maxUploadBytes` (5 MB default). **No virus scanner exists on the platform**; adding ClamAV on the VPS needs a package install on the server — owner's decision (open question Q9). |

The existing shop legal documents and seller-verification files are unchanged.
