import "dotenv/config";
import "reflect-metadata";
import { DaemoBuilder, DaemoHostedConnection } from "daemo-engine";
import { AwsFunctions } from "./AWSFunctions";

async function main() {
  const agentApiKey = process.env.DAEMO_AGENT_API_KEY;
  if (!agentApiKey) throw new Error("Missing DAEMO_AGENT_API_KEY");

  const sessionData = new DaemoBuilder()
    .withServiceName("AWSAgent") 
    .registerService(new AwsFunctions())
    .build();

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















