-- Add seña fields to Order for COD flow with anticipo (mayo 2026)
ALTER TABLE "Order" ADD COLUMN "senaAmount" INTEGER;
ALTER TABLE "Order" ADD COLUMN "senaPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "cashRemainder" INTEGER;
