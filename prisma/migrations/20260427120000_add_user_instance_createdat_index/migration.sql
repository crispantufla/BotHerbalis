-- Adds index on (instanceId, createdAt) to speed up analytics queries that
-- filter users per instance over a date range (overview, demographics,
-- ad-performance, greeting-ab, etc.).
CREATE INDEX IF NOT EXISTS "User_instanceId_createdAt_idx" ON "User"("instanceId", "createdAt");
