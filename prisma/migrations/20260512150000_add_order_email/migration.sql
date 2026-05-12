-- Email opcional capturado en el flujo de Mercado Pago para pre-llenar el
-- checkout y que MP mande el comprobante. Si el cliente no lo provee, queda NULL.
ALTER TABLE "Order" ADD COLUMN "email" TEXT;
