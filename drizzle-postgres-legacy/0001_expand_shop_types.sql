ALTER TYPE "public"."department" ADD VALUE 'GROCERY_KIRANA' BEFORE 'DAIRY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'SUPERMARKET' BEFORE 'DAIRY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'CONVENIENCE_STORE' BEFORE 'DAIRY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'FRUIT_VEGETABLE' BEFORE 'DAIRY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'MEAT_SHOP';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'SWEET_SHOP';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'PHARMACY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'OPTICAL_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'CLOTHING_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'FOOTWEAR_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'JEWELLERY_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'COSMETICS_BEAUTY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'MOBILE_PHONE_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'ELECTRONICS_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'COMPUTER_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'FURNITURE_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'HOME_APPLIANCE_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'HARDWARE_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'PAINT_SANITARY_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'STATIONERY_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'BOOKSTORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'TOY_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'SPORTS_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'PET_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'AUTO_SPARE_PARTS';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'AUTO_ACCESSORIES';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'MOBILE_ELECTRONICS_REPAIR';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'GIFT_SHOP';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'FLOWER_SHOP';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'BUILDING_MATERIALS';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'ELECTRICAL_SHOP';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'AGRICULTURAL_SUPPLY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'POULTRY_SUPPLY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'RESTAURANT';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'FAST_FOOD';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'CAFE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'MEDICAL_EQUIPMENT';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'PRINTING_PHOTOCOPY';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'GENERAL_TRADING';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'PACKAGING_MATERIALS';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'WHOLESALE_STORE';--> statement-breakpoint
ALTER TYPE "public"."department" ADD VALUE 'ONLINE_STORE';--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "shop_type" SET DATA TYPE text;--> statement-breakpoint
-- "BOTH" no longer exists as a shop type: a shop now has one primary type.
-- Any shop previously registered as BOTH (dairy + bakery) is remapped to
-- DAIRY so the enum rebuild below never fails on an unmappable value.
UPDATE "shops" SET "shop_type" = 'DAIRY' WHERE "shop_type" = 'BOTH';--> statement-breakpoint
DROP TYPE "public"."shop_type";--> statement-breakpoint
CREATE TYPE "public"."shop_type" AS ENUM('GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'PHARMACY', 'OPTICAL_STORE', 'CLOTHING_STORE', 'FOOTWEAR_STORE', 'JEWELLERY_STORE', 'COSMETICS_BEAUTY', 'MOBILE_PHONE_STORE', 'ELECTRONICS_STORE', 'COMPUTER_STORE', 'FURNITURE_STORE', 'HOME_APPLIANCE_STORE', 'HARDWARE_STORE', 'PAINT_SANITARY_STORE', 'STATIONERY_STORE', 'BOOKSTORE', 'TOY_STORE', 'SPORTS_STORE', 'PET_STORE', 'AUTO_SPARE_PARTS', 'AUTO_ACCESSORIES', 'MOBILE_ELECTRONICS_REPAIR', 'GIFT_SHOP', 'FLOWER_SHOP', 'BUILDING_MATERIALS', 'ELECTRICAL_SHOP', 'AGRICULTURAL_SUPPLY', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE', 'MEDICAL_EQUIPMENT', 'PRINTING_PHOTOCOPY', 'GENERAL_TRADING', 'PACKAGING_MATERIALS', 'WHOLESALE_STORE', 'ONLINE_STORE');--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "shop_type" SET DATA TYPE "public"."shop_type" USING "shop_type"::"public"."shop_type";