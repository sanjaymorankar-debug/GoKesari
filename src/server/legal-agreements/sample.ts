/**
 * A made-up shop for the admin preview ("preview with a sample shop in all 3 languages") and the tests. Every
 * field is filled so a preview shows every block; nothing here is a real business.
 */
import type { AgreementSnapshot } from "./data";

export function sampleSnapshot(overrides: Partial<AgreementSnapshot> = {}, at: Date = new Date()): AgreementSnapshot {
  return {
    schema: 1,
    shopId: "00000000-0000-4000-8000-000000000001",
    ownerUserId: "00000000-0000-4000-8000-000000000002",
    seller: {
      legalName: "Shree Sample Medical & General Stores",
      tradeName: "Sample Medicals",
      constitution: "PROPRIETORSHIP",
      addressLine: "Shop 4, Sample Plaza, Kharadi, Pune, Maharashtra",
      pincode: "411014",
      googleLocationUrl: "https://maps.google.com/?q=18.5515,73.9348",
      sellerId: "GK-SAMPLE-0001",
      shopTypeKeys: ["PHARMACY"],
      shopTypeLabels: ["Pharmacy / medical store"],
      isMedical: true,
    },
    owner: { name: "Sample Owner Name", designation: "PROPRIETOR", mobileMasked: "+91 98xxxxxx10", email: "owner@example.com" },
    complaintContact: "Sample Owner Name, +91 98xxxxxx10, owner@example.com",
    ids: { pan: "ABCDE1234F", gstin: "27ABCDE1234F1Z5", shopAct: "PMC/SA/2026/000123", udyam: "UDYAM-MH-26-0000001", fssai: null },
    pharmacist: { name: "Sample Pharmacist", registrationNumber: "MSPC-123456", council: "Maharashtra State Pharmacy Council" },
    bankLast4: "4321",
    licences: [
      { kind: "DRUG_LICENCE_RETAIL", customName: null, number: "MH-PZ1-123456", authority: "FDA Maharashtra", validFrom: "2024-04-01", validUntil: "2029-03-31", status: "VERIFIED", reference: "GK-DOC-SAMPLE01", sourceId: null },
      { kind: "GSTIN", customName: null, number: "27ABCDE1234F1Z5", authority: "GST Network", validFrom: null, validUntil: null, status: "VERIFIED", reference: "GST portal", sourceId: null },
      { kind: "PAN", customName: null, number: "ABCDE1234F", authority: "Income Tax Department", validFrom: null, validUntil: null, status: "VERIFIED", reference: "PAN check", sourceId: null },
      { kind: "SHOP_ACT", customName: null, number: "PMC/SA/2026/000123", authority: "Pune Municipal Corporation", validFrom: null, validUntil: null, status: "SUBMITTED", reference: "GK-DOC-SAMPLE02", sourceId: null },
      { kind: "PHARMACIST", customName: null, number: "MSPC-123456", authority: "Maharashtra State Pharmacy Council", validFrom: null, validUntil: null, status: "SUBMITTED", reference: "Pharmacy profile", sourceId: null },
    ],
    licencesAsOf: at.toISOString(),
    fees: {
      registrationFeePaise: 100_000,
      wholesaleRegistrationFeePaise: 250_000,
      commissionBp: 200,
      settlementDays: 3,
      acceptMinutes: 10,
      walletMinimumPaise: 50_000,
      medicineShelfLifeMonths: 3,
      perOrderCommissionPaise: 0,
      billingManagementFeePaise: 0,
    },
    slaChargesPaise: { lateReady: 1_500, sellerCancel: 3_000, lateThenCancel: 4_500, defect: 3_000, medicineBreach: 50_000 },
    platform: { signatoryName: "Sonali Sanjay Morankar", signatoryDesignation: "Director", boardResolutionDate: null, stampDutyBorneBy: "the Merchant", eSealAssetId: null },
    place: "Pune",
    ...overrides,
  };
}
