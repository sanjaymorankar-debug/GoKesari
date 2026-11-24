/**
 * Cashfree Payouts V2 response and webhook shapes, as Cashfree's Payouts V2
 * documentation describes them (API version 2024-01-01). The live sandbox run
 * (.github/workflows/cashfree-payouts-sandbox.yml, live.test.ts) checks the
 * same fields against Cashfree and uploads what it received as the run's
 * artifact; replace a shape here when the recording differs.
 */
export const createAccepted = {
  transfer_id: "gk_test_1",
  cf_transfer_id: "1588542",
  status: "RECEIVED",
  status_code: "RECEIVED",
  status_description: "Request received successfully",
  transfer_amount: 123.45,
  transfer_mode: "imps",
};

export const createSuccess = { ...createAccepted, status: "SUCCESS", status_code: "COMPLETED", transfer_utr: "IMPS1234567890" };

export const createError = { message: "beneficiary_details.beneficiary_instrument_details.bank_ifsc : invalid value provided", code: "beneficiary_ifsc_invalid", type: "invalid_request_error" };

export const createDuplicate = { message: "transfer_id already exists", code: "transfer_id_already_exists", type: "invalid_request_error" };

export const insufficientBalance = { message: "Insufficient balance in the account", code: "insufficient_balance", type: "invalid_request_error" };

export const statusSuccess = { ...createSuccess };

export const statusNotFound = { message: "transfer not found", code: "transfer_not_found", type: "invalid_request_error" };

export function transferWebhook(type: string, data: Record<string, unknown> = {}) {
  return {
    type,
    event_time: "2026-11-23T18:30:00",
    data: { transfer_id: "gk_test_1", cf_transfer_id: "1588542", status: type.replace("TRANSFER_", ""), transfer_amount: 123.45, ...data },
  };
}

export function lowBalanceWebhook(balance: number, at = "2026-11-23T18:30:00") {
  return { type: "LOW_BALANCE_ALERT", event_time: at, data: { current_balance: balance, alert_time: at } };
}
