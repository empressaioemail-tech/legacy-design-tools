-- P-436: Property Explorer map multi-select hands create_screen source map-selection.

ALTER TABLE pe_screen_rows DROP CONSTRAINT IF EXISTS pe_screen_rows_source_chk;

ALTER TABLE pe_screen_rows ADD CONSTRAINT pe_screen_rows_source_chk
  CHECK (source IN (
    'pasted',
    'chrome',
    'gmail',
    'file',
    'walk',
    'saved',
    'map-selection'
  ));
