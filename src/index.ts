import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { adminRouter } from "./routes/admin.js";
import { agentRouter } from "./routes/agent.js";
import { supportRouter } from "./routes/support.js";
import { seedKnowledgeBase } from "./services/knowledgeBase.js";
import { startScheduler } from "./agent/scheduler.js";
import { requireAuth } from "./middleware/auth.js";

seedKnowledgeBase();
startScheduler();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({ name: config.agentName, status: "ok" });
});

app.use("/api/support", supportRouter);
app.use("/api/admin", adminRouter);
app.use("/api/agent", requireAuth, agentRouter);

app.listen(config.port, () => {
  console.log(`${config.agentName} backend listening on port ${config.port}`);
});
