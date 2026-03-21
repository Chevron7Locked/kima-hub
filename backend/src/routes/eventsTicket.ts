import { Router } from "express";
import { randomUUID } from "crypto";
import { redisClient } from "../utils/redis";
import { requireAuthOrToken } from "../middleware/auth";

const router = Router();

router.use(requireAuthOrToken);

router.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const ticket = randomUUID();
  await redisClient.setex(`sse:ticket:${ticket}`, 30, userId);

  res.json({ ticket });
});

export default router;
