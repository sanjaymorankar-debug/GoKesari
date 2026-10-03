-- Full-text indexes for product search and fuzzy candidate retrieval.
--
-- PostgreSQL had a GIN trigram index on search_text and normalized_name, which
-- served three things: the `%` similarity operator, `similarity()` ordering,
-- and `to_tsvector @@ to_tsquery` keyword search. MySQL has none of those, so
-- what it provides instead is a *candidate* index, and the ranking is done in
-- the application, where normalize/text.ts already implements the same
-- definition PostgreSQL's similarity() uses.
--
-- WITH PARSER ngram, not the default word parser. The default one silently
-- drops every token shorter than innodb_ft_min_token_size, which is 3: a search
-- for "LG" or "HP" matches nothing at all, not even as "+lg*", and a catalogue
-- is full of two-letter brands (LG, HP, GE, 3M) and units (ml, kg, tv).
-- PostgreSQL's to_tsvector('simple', ...) had no minimum, so the default parser
-- would have been a silent loss of recall. Measured on MySQL 8.0.46:
--
--   default parser   'lg' -> nothing      '+lg*' -> nothing      'hp' -> nothing
--   ngram parser     'lg' -> 2 rows       'hp'   -> 1 row        'utt' -> "butter"
--
-- The ngram parser also matches substrings, which is closer to how trigram
-- similarity behaved than whole-word matching is. It is noisier on its own -
-- "amul butter" also surfaced "hp laserjet printer" - but that only affects
-- which rows are *retrieved*; they are then re-ranked in the application, which
-- drops the noise and restores the original ordering.
--
-- The alternative was raising innodb_ft_min_token_size, which is a server-level
-- variable: it needs a restart, a rebuild of every full-text index, and it
-- cannot be set on shared hosting. An index built this way needs no server
-- configuration at all, which is why it is this one.
--
-- ngram_token_size defaults to 2. A one-character query cannot be served by
-- this index; PMD's callers already require three characters before searching
-- fuzzily, so nothing regresses.
--
-- The stopword list has to be off while these are built, and that is not a
-- nicety. InnoDB applies its default stopword list to *tokens*, and under the
-- ngram parser a token is a 2-gram - so every 2-gram that happens to be an
-- English stopword is dropped from the index. Fifteen of the thirty-five
-- defaults are exactly two characters: an, as, at, be, by, de, en, in, is, it,
-- la, of, on, or, to. Any word containing one of those pairs then has a hole in
-- the middle of its gram sequence and can no longer be matched as a phrase.
-- Measured on MySQL 8.0.46, with the list on:
--
--   "tata"       -> nothing   (ta-AT-ta)
--   "patanjali"  -> nothing   (pa-AT-an-nj-...)
--   "amul"       -> matches   (am-mu-ul, none of them stopwords)
--
-- So Tata, Patanjali, Britannia and Colgate would all have been unfindable
-- while Amul worked, with nothing to indicate why.
--
-- It is a SESSION variable here rather than a server setting on purpose: it is
-- read when the index is built, not when it is queried, so setting it for this
-- one connection is enough and the deployment needs no server configuration.
-- Verified: an index built with it OFF still matches correctly from a
-- connection using the default ON.

SET SESSION innodb_ft_enable_stopword = OFF;

ALTER TABLE pmd.product_master
  ADD FULLTEXT KEY product_master_search_ft (search_text) WITH PARSER ngram;

ALTER TABLE pmd.product_master
  ADD FULLTEXT KEY product_master_name_ft (normalized_name) WITH PARSER ngram;
