import "./env";
import dns from "dns";
import Express from "express";
import cors from "cors";
import satRoutes from "./routes/sat";
import { startSatMessaging } from "./sat/messaging";
import { startSatAutomations } from "./sat/automations";

dns.setDefaultResultOrder("ipv4first");
const PORT = process.env.PORT || 3333;

const app = Express();

app.use(cors());
app.use(Express.json());

app.use("/sat", satRoutes);

app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
  startSatMessaging();
  startSatAutomations();
});
