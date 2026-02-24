-- CreateTable
CREATE TABLE "User" (
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profileData" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pendiente',
    "products" TEXT NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "tracking" TEXT,
    "postdated" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatLog" (
    "id" TEXT NOT NULL,
    "userPhone" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "BotConfig_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userPhone_fkey" FOREIGN KEY ("userPhone") REFERENCES "User"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatLog" ADD CONSTRAINT "ChatLog_userPhone_fkey" FOREIGN KEY ("userPhone") REFERENCES "User"("phone") ON DELETE RESTRICT ON UPDATE CASCADE;
