-- Add processed field to blocks table
-- SQLite
ALTER TABLE blocks ADD COLUMN processed BOOLEAN DEFAULT false;
CREATE INDEX idx_blocks_processed ON blocks(processed);

-- PostgreSQL
ALTER TABLE blocks ADD COLUMN processed BOOLEAN DEFAULT false;
CREATE INDEX idx_blocks_processed ON blocks(processed);

-- MySQL
ALTER TABLE blocks ADD COLUMN processed BOOLEAN DEFAULT false;
ALTER TABLE blocks ADD INDEX idx_processed (processed);