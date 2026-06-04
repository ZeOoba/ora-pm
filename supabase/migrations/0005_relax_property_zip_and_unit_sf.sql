-- Model refinements surfaced during portfolio onboarding.
--
-- 1) properties.zip → nullable.
--    ORA's system of record (the Master Excel workbook / Command Center) tracks
--    properties as "street, city, state" and does not carry ZIP. Requiring ZIP
--    NOT NULL would force fabricated data. city + state remain required.
ALTER TABLE properties ALTER COLUMN zip DROP NOT NULL;

-- 2) units.sf CHECK → allow zero.
--    Zero-SF leases are legitimate in this portfolio: billboard/antenna/rooftop
--    licenses (e.g., Lamar Advantage at 3034 Westerville) carry rent but no SF.
--    The rent_roll view already guards $/SF with NULLIF(sf, 0), so zero is safe.
ALTER TABLE units DROP CONSTRAINT IF EXISTS units_sf_check;
ALTER TABLE units ADD CONSTRAINT units_sf_check CHECK (sf >= 0);
