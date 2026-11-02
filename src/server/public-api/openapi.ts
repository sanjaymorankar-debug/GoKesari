/** The public REST API's OpenAPI 3.1 description (billing v2, docs/billing §8, deliverable "API docs"). */
export const PUBLIC_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "GoKesari public API",
    version: "1.0.0",
    description:
      "Read and write a shop's books on GoKesari from other software. OAuth2 client credentials: the shop owner creates a client (GoKesari → Accounts → Sync → API access) with scopes; trade its id and secret at /oauth/token for a one-hour bearer token. Amounts are in paise (integers); dates are YYYY-MM-DD; `to` is exclusive.",
  },
  servers: [{ url: "/api/public/v1" }],
  components: {
    securitySchemes: { oauth2: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "/api/public/v1/oauth/token", scopes: { "books:read": "Read the books", "books:write": "Add vouchers and masters", "invoices:read": "Read invoices", "stock:read": "Read stock", "stock:write": "Update item HSN / GST / price", "parties:read": "Read parties" } } } } },
    parameters: {
      from: { name: "from", in: "query", required: true, schema: { type: "string", format: "date" } },
      to: { name: "to", in: "query", required: true, schema: { type: "string", format: "date" }, description: "Exclusive." },
    },
    schemas: {
      Books: { type: "object", description: "schema gokesari.books/1: company, ledgerGroups, ledgers, stockGroups, units, godowns, stockItems, batches, vouchers (ledgerLines + = debit, − = credit; inventoryLines; taxLines)." },
      ImportSummary: { type: "object", properties: { parties: { type: "object" }, items: { type: "object" }, vouchers: { type: "object" }, conflicts: { type: "integer" } } },
    },
  },
  paths: {
    "/oauth/token": {
      post: {
        summary: "Get an access token (client credentials)",
        requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["grant_type", "client_id", "client_secret"], properties: { grant_type: { const: "client_credentials" }, client_id: { type: "string" }, client_secret: { type: "string" }, scope: { type: "string" } } } } } },
        responses: { "200": { description: "access_token, token_type Bearer, expires_in 3600, scope" }, "400": { description: "invalid_scope / unsupported_grant_type" }, "401": { description: "invalid_client" } },
      },
    },
    "/books": {
      get: { summary: "The shop's books in canonical form", security: [{ oauth2: ["books:read"] }], parameters: [{ $ref: "#/components/parameters/from" }, { $ref: "#/components/parameters/to" }], responses: { "200": { description: "Books", content: { "application/json": { schema: { $ref: "#/components/schemas/Books" } } } } } },
      post: { summary: "Add masters and vouchers (masters first; re-sending is idempotent; changes after exchange are held as conflicts)", security: [{ oauth2: ["books:write"] }], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Books" } } } }, responses: { "200": { description: "Import summary", content: { "application/json": { schema: { $ref: "#/components/schemas/ImportSummary" } } } } } },
    },
    "/invoices": { get: { summary: "GoKesari order invoices (gokesari.invoice/1) and counter-sale invoices", security: [{ oauth2: ["invoices:read"] }], parameters: [{ $ref: "#/components/parameters/from" }, { $ref: "#/components/parameters/to" }], responses: { "200": { description: "{ online, counter }" } } } },
    "/stock": {
      get: { summary: "Stock summary (quantity in milli-units, value at cost)", security: [{ oauth2: ["stock:read"] }], responses: { "200": { description: "Stock" } } },
      patch: { summary: "Update items' HSN, GST rate, cess, price (matched by name or barcode)", security: [{ oauth2: ["stock:write"] }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { stockItems: { type: "array" } } } } } }, responses: { "200": { description: "Import summary" } } },
    },
    "/parties": { get: { summary: "Customers and suppliers", security: [{ oauth2: ["parties:read"] }], responses: { "200": { description: "Parties" } } } },
  },
} as const;
