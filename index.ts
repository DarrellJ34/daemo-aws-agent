import "dotenv/config";
import "reflect-metadata";
import { DaemoHostedConnection } from "daemo-engine";
import { buildSessionData } from "./src/agentSession.js";

async function main() {
  const agentApiKey = process.env.DAEMO_AGENT_API_KEY;
  if (!agentApiKey) throw new Error("Missing DAEMO_AGENT_API_KEY");

  const sessionData = buildSessionData();

  const connection = new DaemoHostedConnection(
    {
      agentApiKey,
      daemoGatewayUrl: process.env.DAEMO_GATEWAY_URL,
    },
    sessionData
  );

  await connection.start();
  console.log("AWS Agent is online");
}

main().catch(console.error);
