Overview:

Daemo is an AI runtime that allows you to have AI Agents work with your
databases and services in a more secure way

read more about Daemo:
https://docs.daemo.ai/docs/

----------------------------------------------------

Daemo AWS Agent

An AWS operations assistant powered by daemo-engine.  
This agent lets you interact with AWS services through safe, structured tools instead of manual console work.

What This Repo Does

- Runs a Daemo hosted tool service so your agent can call AWS tools (S3, EC2, RDS)  
- Optionally serves a local browser chat UI (HTML/CSS/JS)  
- Exposes a local HTTP endpoint your UI can use to talk to the agent  
- In short: it’s an AI-powered AWS helper you can run locally
- More capabilities will be coming

Capabilities

S3
- List keys in a fixed bucket  
- Read/write small text objects  
- Generate presigned download URLs  
- Find older objects for cleanup  

EC2
- List instances (basic info)  
- Detect likely idle instances using CloudWatch metrics  

RDS
- List DB instances and snapshots  
- Fetch CPU utilization metrics  
- Run read-only MySQL queries  
- Allowed: SELECT, SHOW, DESCRIBE  
- No writes or destructive queries  

Prerequisites

- Node.js 20+  
- AWS credentials available to the process (env vars, shared config, SSO, etc.)
- Correct AWS policies to allow read/write 
- A Daemo Agent API key  

Configuration

Create a .env file in the project root.  
Do not commit this file.

Core Config

```env
DAEMO_AGENT_API_KEY="your_daemo_agent_api_key"
DAEMO_GATEWAY_URL="http://localhost:50052"
AWS_REGION="us-east-1" (can be a different region)
ALLOWED_BUCKETS="s3_bucket_name, another_s3_bucket"
```

RDS Config (only needed if using RDS query tool)

```env
RDS_HOST="your-rds-endpoint.amazonaws.com"
RDS_USER="readonly_user"
RDS_PASSWORD="readonly_password"
RDS_DB="optional_database"
RDS_PORT="3306"
RDS_SSL="true"
```

Install

```bash
npm install
```

Run

Hosted Tools Only

```bash
npm run start
```

Local Browser Chat UI

- Starts hosted tool service  
- Starts local HTTP server  
- Serves chat UI  
- Exposes POST /api/chat  

```bash
npm run web
```

Open in browser  
http://127.0.0.1:8787

Change Port

```bash
PORT=3000 npm run web
```

Then open  
http://127.0.0.1:3000

Safety Notes

- The browser UI never sees DAEMO_AGENT_API_KEY  
- API key stays server-side  
- RDS queries are read-only by design  
- S3 access is locked to a single bucket in code (see AWSFunctions.ts)  

Project Layout

index.ts  
- Starts the hosted Daemo connection  

AWSFunctions.ts  
- Tool definitions exposed to the agent  

public/  
- Static chat UI assets  

<img width="1470" height="956" alt="Screenshot 2026-02-01 at 10 09 47 AM" src="https://github.com/user-attachments/assets/db171841-cbc2-4012-9e10-73860ec0c07c" />

<img width="1470" height="956" alt="Screenshot 2026-02-01 at 10 11 30 AM" src="https://github.com/user-attachments/assets/f93fa058-a2a2-49bc-b79b-ae95fbe33484" />
