/**
 * The Grievance Officer's details, editable by an admin (rule
 * grievanceOfficer, Admin → Settings). Read by the Grievance Redressal page,
 * the Contact page, the support portal and the compliance dashboard. A field
 * the admin left empty falls back to LEGAL_ENTITY.grievanceOfficer.
 */
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { getRule } from "@/server/services/settings";

export interface GrievanceOfficer {
  name: string;
  designation: string;
  email: string;
  phone: string;
  address: string;
  hours: string;
}

export async function getGrievanceOfficer(): Promise<GrievanceOfficer> {
  const fallback = LEGAL_ENTITY.grievanceOfficer;
  let rule: Partial<GrievanceOfficer> = {};
  try {
    rule = await getRule("grievanceOfficer");
  } catch {
    rule = {};
  }
  const pick = (value: string | undefined, constant: string) => (value && value.trim() ? value.trim() : constant);
  return {
    name: pick(rule.name, fallback.name),
    designation: pick(rule.designation, fallback.designation),
    email: pick(rule.email, fallback.email),
    phone: pick(rule.phone, fallback.phone),
    address: pick(rule.address, fallback.address),
    hours: pick(rule.hours, ""),
  };
}
