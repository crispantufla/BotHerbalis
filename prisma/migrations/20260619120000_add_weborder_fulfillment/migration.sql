-- AlterTable
ALTER TABLE "WebOrder" ADD COLUMN     "shipped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "tracking" TEXT;
