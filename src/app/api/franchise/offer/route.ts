/** Public: the franchise offer — fee, GST, validity, launch places left, the rules text and its version. */
import { ESTIMATE_DISCLOSURE, FRANCHISE_AGREEMENT_TEXT, FRANCHISE_AGREEMENT_VERSION, FRANCHISE_CONTACT_PHONE, ILLUSTRATION_DISCLOSURE } from "@/lib/franchise";
import { ok, route } from "@/server/api/handler";
import { offerView } from "@/server/franchise/booking";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  return ok({ offer: await offerView(), agreement: { version: FRANCHISE_AGREEMENT_VERSION, text: FRANCHISE_AGREEMENT_TEXT }, disclosure: ESTIMATE_DISCLOSURE, illustration: ILLUSTRATION_DISCLOSURE, contact: FRANCHISE_CONTACT_PHONE });
});
