-- AlterTable
-- Confirmaciones post-pago de la tienda web: la web marca emailNotifiedAt al
-- mandar el email; el bot marca whatsappNotifiedAt al mandar el WhatsApp.
ALTER TABLE "WebOrder" ADD COLUMN     "emailNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappNotifiedAt" TIMESTAMP(3);
