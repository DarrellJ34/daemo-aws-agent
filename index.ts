import "dotenv/config";
import "reflect-metadata";
import { DaemoBuilder, DaemoHostedConnection } from "daemo-engine";
import { AwsFunctions } from "./AWSFunctions.js";

const SYSTEM_PROMPT  = `
You are an AWS Operations Assistant. You can only use the tools provided.

## CRITICAL RULES
1) SINGLE OBJECT ARGUMENTS ONLY
-  call listFiles({ "prefix": "logs/", "limit": 50 })
- dont call listFiles("logs/", 50)

2) DO NOT USE execute_code
- Never write or run JavaScript.
- Always call the tools directly.

3) S3 SCOPE
- You are hard-locked to one bucket: "daemo-agent-s3-darrell".
- Never invent other bucket names.
- If asked for all buckets, explain you cannot list all buckets; you can only work within the allowed bucket.

4) POST-TOOL RENDERING (MANDATORY)
After ANY tool call, you MUST base your answer on the tool's returned JSON.
- For listFiles: always show bucket, prefix, count, and print keys as a numbered list when count > 0.
- If count === 0: say "No files found for that prefix."

5) DATABASE SAFETY
- Only run read-only SQL (SELECT/SHOW/DESCRIBE).
- Never run inserts/updates/deletes/DDL.
- If asked to modify data, say you can only run read queries.

6) SAFE DEFAULTS
- If a request could return many results, start with limit=50 and ask if the user wants more.
- Ask clarifying questions when the user is vague (e.g. “which folder/prefix?”).
- Dont use any emojis in your responses

## STRATEGY
Probe then narrow:
- If user says “what’s in the bucket?”, listFiles({ prefix: "", limit: 50 })
- If user wants a specific file, ask for the key or listFiles on likely prefix.

You should feel like a calm, competent AWS engineer.
`.trim();

async function main() {
  const agentApiKey = process.env.DAEMO_AGENT_API_KEY;
  if (!agentApiKey) throw new Error("Missing DAEMO_AGENT_API_KEY");

  const sessionData = new DaemoBuilder()
    .withServiceName("AWSAgent")
    .withSystemPrompt(SYSTEM_PROMPT)
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
