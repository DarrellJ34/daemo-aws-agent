import "dotenv/config";
import "reflect-metadata";
import { DaemoHostedConnection } from "daemo-engine";
import { buildSessionData } from "./src/agentSession.js";

/*
.env vars

DAEMO_AGENT_API_KEY
DAEMO_GATEWAY_URL
DAEMO_AGENT_URL

ALLOWED_BUCKETS

// for IAM user to access S3 and EC2
AWS_REGION
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY

// for specific RDS DB instance. Acts as a server for a MySQL DB
RDS_HOST
RDS_USER
RDS_PASSWORD
*/

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
