-- The shop-category picker list, ported from the Postgres original
-- (drizzle-postgres-legacy/0035). The categories are reference data, not
-- user data: the /api/shop-categories picker and shop registration both
-- expect them to exist on a fresh database.
--
-- `id` is supplied here because the port moved primary-key generation into the
-- application (schema.ts `uuidPk`), so the column has no database default. MySQL's
-- UUID() keeps the seed self-contained rather than hard-coding 44 literals.
--
-- `ON DUPLICATE KEY UPDATE slug = slug` is MySQL's ON CONFLICT DO NOTHING: it
-- touches nothing, so re-running this is safe and will not overwrite a name an
-- operator has since edited.
--
-- The original also back-filled `shop_category_mapping` from each existing
-- shop's `shop_type`. That is not ported: it only had work to do on a database
-- that already held shops, and a database created from these migrations has
-- none. A tier migrating real data from PostgreSQL must run that mapping
-- itself, after the rows are copied across.
INSERT INTO `shop_categories` (`id`, `name`, `slug`)
VALUES
  (UUID(), 'Grocery / Kirana Store', 'grocery-kirana'),
  (UUID(), 'Supermarket', 'supermarket'),
  (UUID(), 'Convenience Store', 'convenience-store'),
  (UUID(), 'Fruit and Vegetable Shop', 'fruit-vegetable'),
  (UUID(), 'Dairy Shop', 'dairy'),
  (UUID(), 'Bakery', 'bakery'),
  (UUID(), 'Meat Shop', 'meat-shop'),
  (UUID(), 'Sweet Shop', 'sweet-shop'),
  (UUID(), 'Pharmacy / Medical Store', 'pharmacy'),
  (UUID(), 'Optical Store', 'optical-store'),
  (UUID(), 'Clothing Store', 'clothing-store'),
  (UUID(), 'Footwear Store', 'footwear-store'),
  (UUID(), 'Jewellery Store', 'jewellery-store'),
  (UUID(), 'Cosmetics and Beauty Store', 'cosmetics-beauty'),
  (UUID(), 'Mobile Phone Store', 'mobile-phone-store'),
  (UUID(), 'Electronics Store', 'electronics-store'),
  (UUID(), 'Computer Store', 'computer-store'),
  (UUID(), 'Furniture Store', 'furniture-store'),
  (UUID(), 'Home Appliance Store', 'home-appliance-store'),
  (UUID(), 'Hardware Store', 'hardware-store'),
  (UUID(), 'Paint and Sanitary Store', 'paint-sanitary-store'),
  (UUID(), 'Stationery Store', 'stationery-store'),
  (UUID(), 'Bookstore', 'bookstore'),
  (UUID(), 'Toy Store', 'toy-store'),
  (UUID(), 'Sports Store', 'sports-store'),
  (UUID(), 'Pet Store', 'pet-store'),
  (UUID(), 'Automobile Spare Parts Shop', 'auto-spare-parts'),
  (UUID(), 'Auto Accessories Shop', 'auto-accessories'),
  (UUID(), 'Mobile and Electronics Repair Shop', 'mobile-electronics-repair'),
  (UUID(), 'Gift Shop', 'gift-shop'),
  (UUID(), 'Flower Shop', 'flower-shop'),
  (UUID(), 'Hardware and Building Materials', 'building-materials'),
  (UUID(), 'Electrical Shop', 'electrical-shop'),
  (UUID(), 'Agricultural Supply Store', 'agricultural-supply'),
  (UUID(), 'Poultry Supply Store', 'poultry-supply'),
  (UUID(), 'Restaurant', 'restaurant'),
  (UUID(), 'Fast-Food Outlet', 'fast-food'),
  (UUID(), 'Café / Coffee Shop', 'cafe'),
  (UUID(), 'Medical Equipment Store', 'medical-equipment'),
  (UUID(), 'Printing and Photocopy Shop', 'printing-photocopy'),
  (UUID(), 'General Trading Store', 'general-trading'),
  (UUID(), 'Packaging Materials Shop', 'packaging-materials'),
  (UUID(), 'Wholesale Store', 'wholesale-store'),
  (UUID(), 'Online Store / E-commerce', 'online-store')
ON DUPLICATE KEY UPDATE `slug` = `slug`;
