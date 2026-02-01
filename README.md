Daemo AWS Agent

An AWS operations assistant powered by daemo-engine.

What this repo does
- Runs a Daemo hosted tool service so your agent can call your AWS tools (S3 / EC2 / RDS)
- Optionally serves a local browser chat UI (HTML/CSS/JS) that talks to your agent through a local HTTP endpoint

Capabilities
S3
- List keys in a fixed bucket
- Read/write small text objects
- Generate presigned download URLs
- Find older objects for cleanup

EC2
- List instances (basic info)
- Detect likely-idle instances using CloudWatch metrics

RDS
- List instances and snapshots
- Fetch CPU utilization metrics
- Run read-only MySQL queries (SELECT/SHOW/DESCRIBE only)

Prerequisites
- Node.js 20+
- AWS credentials available to the process (env vars, shared config, SSO, etc.)
- A Daemo Agent API key

Configuration
Create a .env file in the project root (do not commit it):

DAEMO_AGENT_API_KEY="your_daemo_agent_api_key"
DAEMO_GATEWAY_URL="http://localhost:50052"   (optional, if you use a non-default gateway URL)
AWS_REGION="us-east-1"                      (typical)

RDS (optional, only if you use the RDS query tool)
RDS_HOST="your-rds-endpoint.amazonaws.com"
RDS_USER="readonly_user"
RDS_PASSWORD="readonly_password"
RDS_DB="optional_database"
RDS_PORT="3306"
RDS_SSL="true"

Install
cd /Users/darrelljustice/Desktop/Daemo
npm install

Run (hosted tools only)
This connects your tool service to the Daemo Gateway so your agent can call tools.

npm run start

Run (local browser chat UI)
This starts the hosted tool service plus a local HTTP server that serves the UI and exposes POST /api/chat.

npm run web

Open in your browser
http://127.0.0.1:8787

Change the port
PORT=3000 npm run web
Then open http://127.0.0.1:3000

Notes / Safety
- The browser UI never sees DAEMO_AGENT_API_KEY. It stays server-side.
- RDS queries are read-only by design (SELECT/SHOW/DESCRIBE only).
- S3 access is locked to a single bucket in code (see AWSFunctions.ts).

Project layout
- index.ts: starts the hosted Daemo connection (tools online)
- AWSFunctions.ts: tool definitions exposed to the agent
- public: static chat UI assets

<img width="1470" height="956" alt="Screenshot 2026-02-01 at 10 09 47 AM" src="https://github.com/user-attachments/assets/db171841-cbc2-4012-9e10-73860ec0c07c" />

<img width="1470" height="956" alt="Screenshot 2026-02-01 at 10 11 30 AM" src="https://github.com/user-attachments/assets/f93fa058-a2a2-49bc-b79b-ae95fbe33484" />
