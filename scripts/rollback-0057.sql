-- Reverses drizzle/0057_rider_kyc_documents.sql (C5). Switch
-- riderFiles.kycDocuments off first and deploy the previous build. Back up
-- first: this drops the document links. The images themselves stay in
-- stored_images; to erase them as well, run the DELETE below too.
-- Afterwards delete the 0057 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS delivery_partner_documents;
-- Optional, erases the uploaded document images:
-- DELETE FROM stored_images WHERE purpose = 'RIDER_KYC_DOC';
COMMIT;
