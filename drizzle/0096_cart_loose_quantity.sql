-- split: core
-- D-95: a cart line of a loose good can be part of a sellable unit (250 g of a
-- loose 1 kg listing is 0.25). Packaged goods stay whole: the application
-- refuses decimals for them. Re-runnable (same type again changes nothing).
ALTER TABLE "cart_items" ALTER COLUMN "quantity" TYPE numeric(10, 3);
