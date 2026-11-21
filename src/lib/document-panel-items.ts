/**
 * The document checklist (services/document-uploads.ts) as the upload panel's cards. Shared by the
 * owner's "Upload your documents" page and the admin's "Upload documents for the owner" page, which
 * render the same panel for the same shop.
 */
import type { PanelItem } from "@/components/document-upload-panel";
import type { DocumentChecklist } from "@/server/services/document-uploads";

export function toPanelItems(checklist: DocumentChecklist): PanelItem[] {
  return checklist.items.map((item) => ({
    docType: item.docType,
    label: item.label,
    requirement: item.requirement,
    status: item.status,
    validUntil: item.validUntil,
    done: item.done,
    additional: item.additional,
    held: item.held,
    latest: item.latest
      ? {
          id: item.latest.id,
          status: item.latest.status,
          fields: item.latest.fields,
          flags: item.latest.flags,
          blocking: item.latest.blocking,
          contentType: item.latest.contentType,
          readerEngine: item.latest.readerEngine,
          validUntil: item.latest.validUntil,
          numberLast4: item.latest.numberLast4,
          confirmedAt: item.latest.confirmedAt?.toISOString() ?? null,
        }
      : null,
  }));
}
