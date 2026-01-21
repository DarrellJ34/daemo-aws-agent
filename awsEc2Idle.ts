import {
  EC2Client,
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  type Instance,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

function getRegion(): string {
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("Missing AWS_REGION in environment");
  return region;
}

const ec2 = new EC2Client({ region: getRegion() });
const cw = new CloudWatchClient({ region: getRegion() });

export type Ec2InstanceSummary = {
  instanceId: string;
  name?: string;
  instanceType?: string;
  state?: string;
  launchTime?: string;
  availabilityZone?: string;
  tags?: Record<string, string>;
};

export type IdleMetrics = {
  cpuAvg?: number; // percent
  netInBytesTotal?: number;
  netOutBytesTotal?: number;

  dataPointsCpu?: number;
  dataPointsNetIn?: number;
  dataPointsNetOut?: number;
};

export type IdleCandidate = Ec2InstanceSummary &
  IdleMetrics & {
    idle: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reason: string[];
  };

function tagsToRecord(tags?: Instance["Tags"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) {
    if (t.Key && typeof t.Value === "string") out[t.Key] = t.Value;
  }
  return out;
}

function getNameTag(tags?: Record<string, string>): string | undefined {
  const n = tags?.Name;
  return typeof n === "string" && n.trim().length > 0 ? n : undefined;
}

function toIso(d?: Date): string | undefined {
  return d ? d.toISOString() : undefined;
}

export async function listRunningInstancesCapped(
  maxInstances: number
): Promise<Ec2InstanceSummary[]> {
  const items: Ec2InstanceSummary[] = [];
  let nextToken: string | undefined = undefined;

  while (items.length < maxInstances) {
    const remaining = maxInstances - items.length;

    const maxResults = Math.min(1000, Math.max(5, remaining));

    const resp: DescribeInstancesCommandOutput = await ec2.send(
      new DescribeInstancesCommand({
        NextToken: nextToken,
        MaxResults: maxResults,
        Filters: [{ Name: "instance-state-name", Values: ["running"] }],
      })
    );

    for (const res of resp.Reservations ?? []) {
      for (const inst of res.Instances ?? []) {
        if (!inst.InstanceId) continue;

        const tags = tagsToRecord(inst.Tags);
        items.push({
          instanceId: inst.InstanceId,
          name: getNameTag(tags),
          instanceType: inst.InstanceType,
          state: inst.State?.Name,
          launchTime: toIso(inst.LaunchTime),
          availabilityZone: inst.Placement?.AvailabilityZone,
          tags,
        });

        if (items.length >= maxInstances) break;
      }
      if (items.length >= maxInstances) break;
    }

    if (!resp.NextToken) break;
    nextToken = resp.NextToken;
  }

  return items;
}

function safeId(prefix: string, idx: number): string {
  return `${prefix}${idx}`.toLowerCase();
}

function avg(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

function sum(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((a, b) => a + b, 0);
}

type MetricAgg = {
  cpuAvg?: number;
  cpuN?: number;
  netInTotal?: number;
  netInN?: number;
  netOutTotal?: number;
  netOutN?: number;
};

export async function getIdleMetricsForInstances(
  instanceIds: string[],
  lookbackDays: number,
  periodSeconds: number
): Promise<Record<string, IdleMetrics>> {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const queries: MetricDataQuery[] = [];
  instanceIds.forEach((id, i) => {
    queries.push({
      Id: safeId("cpu", i),
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: "CPUUtilization",
          Dimensions: [{ Name: "InstanceId", Value: id }],
        },
        Period: periodSeconds,
        Stat: "Average",
      },
    });

    queries.push({
      Id: safeId("ni", i),
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: "NetworkIn",
          Dimensions: [{ Name: "InstanceId", Value: id }],
        },
        Period: periodSeconds,
        Stat: "Sum",
      },
    });

    queries.push({
      Id: safeId("no", i),
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: "NetworkOut",
          Dimensions: [{ Name: "InstanceId", Value: id }],
        },
        Period: periodSeconds,
        Stat: "Sum",
      },
    });
  });

  const MAX_QUERIES_PER_CALL = 450; 
  const chunks: MetricDataQuery[][] = [];
  for (let i = 0; i < queries.length; i += MAX_QUERIES_PER_CALL) {
    chunks.push(queries.slice(i, i + MAX_QUERIES_PER_CALL));
  }

  const aggByInstance: Record<string, MetricAgg> = {};

  function ensureAgg(instanceId: string): MetricAgg {
    if (!aggByInstance[instanceId]) aggByInstance[instanceId] = {};
    return aggByInstance[instanceId];
  }

  const indexToInstanceId = instanceIds;

  for (const chunk of chunks) {
    let nextToken: string | undefined = undefined;

    do {
      const resp: GetMetricDataCommandOutput = await cw.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          MetricDataQueries: chunk,
          NextToken: nextToken,
          ScanBy: "TimestampAscending",
        })
      );

      for (const r of resp.MetricDataResults ?? []) {
        const qid = r.Id ?? "";

        const values = (r.Values ?? []).filter(
          (v: number | undefined): v is number =>
            typeof v === "number" && Number.isFinite(v)
        );

        const m = qid.match(/^(cpu|ni|no)(\d+)$/);
        if (!m) continue;

        const kind = m[1];
        const idx = Number(m[2]);
        if (!Number.isFinite(idx) || idx < 0 || idx >= indexToInstanceId.length)
          continue;

        const instanceId = indexToInstanceId[idx];
        const agg = ensureAgg(instanceId);

        if (kind === "cpu") {
          agg.cpuAvg = avg(values);
          agg.cpuN = values.length;
        } else if (kind === "ni") {
          agg.netInTotal = sum(values);
          agg.netInN = values.length;
        } else if (kind === "no") {
          agg.netOutTotal = sum(values);
          agg.netOutN = values.length;
        }
      }

      nextToken = resp.NextToken;
    } while (nextToken);
  }

  const out: Record<string, IdleMetrics> = {};
  for (const id of instanceIds) {
    const a = aggByInstance[id] ?? {};
    out[id] = {
      cpuAvg: a.cpuAvg,
      netInBytesTotal: a.netInTotal,
      netOutBytesTotal: a.netOutTotal,
      dataPointsCpu: a.cpuN,
      dataPointsNetIn: a.netInN,
      dataPointsNetOut: a.netOutN,
    };
  }

  return out;
}
export function classifyIdle(
  inst: Ec2InstanceSummary,
  metrics: IdleMetrics,
  cpuThresholdPct: number,
  netTotalThresholdBytes: number,
  minDataPoints: number,
  excludeTagKeys: string[]
): IdleCandidate {
  const reason: string[] = [];

  const tags = inst.tags ?? {};
  const excluded = excludeTagKeys.some((k) => k in tags);
  if (excluded) {
    reason.push(
      `Excluded (has one of these tag keys): ${excludeTagKeys.join(", ")}`
    );
  }

  const cpuPts = metrics.dataPointsCpu ?? 0;
  const niPts = metrics.dataPointsNetIn ?? 0;
  const noPts = metrics.dataPointsNetOut ?? 0;

  const hasEnoughData =
    cpuPts >= minDataPoints && niPts >= minDataPoints && noPts >= minDataPoints;

  if (!hasEnoughData) {
    reason.push(
      `Low metric coverage (cpu=${cpuPts}, netIn=${niPts}, netOut=${noPts}; min=${minDataPoints}).`
    );
  }

  const cpuOk =
    typeof metrics.cpuAvg === "number" && metrics.cpuAvg <= cpuThresholdPct;

  const netTotal =
    (metrics.netInBytesTotal ?? 0) + (metrics.netOutBytesTotal ?? 0);

  const netOk =
    Number.isFinite(netTotal) && netTotal <= netTotalThresholdBytes;

  reason.push(
    `CPU avg: ${metrics.cpuAvg?.toFixed(2) ?? "N/A"}% (threshold ${cpuThresholdPct}%)`
  );
  reason.push(
    `Network total: ${Math.round(netTotal)} bytes (threshold ${netTotalThresholdBytes} bytes)`
  );

  const idle = !excluded && hasEnoughData && cpuOk && netOk;

  let confidence: IdleCandidate["confidence"] = "LOW";
  if (excluded) confidence = "LOW";
  else if (hasEnoughData && cpuOk && netOk) confidence = "HIGH";
  else if (hasEnoughData) confidence = "MEDIUM";

  return {
    ...inst,
    ...metrics,
    idle,
    confidence,
    reason,
  };
}
