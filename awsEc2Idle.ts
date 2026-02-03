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

const ec2Client = new EC2Client({ region: getRegion() });
const cloudWatchClient = new CloudWatchClient({ region: getRegion() });

export type ec2InstanceSummary = {
  instanceId: string;
  name?: string;
  instanceType?: string;
  state?: string;
  launchTime?: string;
  availabilityZone?: string;
  tags?: Record<string, string>;
};

export type idleMetrics = {
  cpuAvg?: number; // CPU percent
  netInBytesTotal?: number;
  netOutBytesTotal?: number;

  dataPointsCpu?: number;
  dataPointsNetIn?: number;
  dataPointsNetOut?: number;
};

export type idleCandidate = ec2InstanceSummary &
  idleMetrics & {
    idle: boolean;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reason: string[];
  };

function tagsToRecord(tags?: Instance["Tags"]): Record<string, string> {
  const tagsRecord: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.Key && typeof tag.Value === "string") tagsRecord[tag.Key] = tag.Value;
  }
  return tagsRecord;
}

function getNameTag(tags?: Record<string, string>): string | undefined {
  const nameValue = tags?.Name;
  return typeof nameValue === "string" && nameValue.trim().length > 0
    ? nameValue
    : undefined;
}

function toIsoString(date?: Date): string | undefined {
  return date ? date.toISOString() : undefined;
}

// Basic lookup without CloudWatch metrics or idle classification.
export async function listEc2InstancesSimple(
  maxInstances: number,
  instanceStates: string[] = ["running"]
): Promise<ec2InstanceSummary[]> {
  return await listEc2InstancesCapped(maxInstances, instanceStates);
}

// Shared helper with state filter and safe pagination.
async function listEc2InstancesCapped(
  maxInstances: number,
  instanceStates: string[]
): Promise<ec2InstanceSummary[]> {
  const instances: ec2InstanceSummary[] = [];
  let nextToken: string | undefined = undefined;

  while (instances.length < maxInstances) {
    const remaining = maxInstances - instances.length;

    // AWS expects MaxResults between 5 and 1000.
    const maxResults = Math.min(1000, Math.max(5, remaining));

    const resp: DescribeInstancesCommandOutput = await ec2Client.send(
      new DescribeInstancesCommand({
        NextToken: nextToken,
        MaxResults: maxResults,
        Filters: [{ Name: "instance-state-name", Values: instanceStates }],
      })
    );

    for (const reservation of resp.Reservations ?? []) {
      for (const inst of reservation.Instances ?? []) {
        if (!inst.InstanceId) continue;

        const tags = tagsToRecord(inst.Tags);
        instances.push({
          instanceId: inst.InstanceId,
          name: getNameTag(tags),
          instanceType: inst.InstanceType,
          state: inst.State?.Name,
          launchTime: toIsoString(inst.LaunchTime),
          availabilityZone: inst.Placement?.AvailabilityZone,
          tags,
        });

        if (instances.length >= maxInstances) break;
      }
      if (instances.length >= maxInstances) break;
    }

    if (!resp.NextToken) break;
    nextToken = resp.NextToken;
  }

  return instances;
}

// Idle detection helpers

export async function listRunningInstancesCapped(
  maxInstances: number
): Promise<ec2InstanceSummary[]> {
  return await listEc2InstancesCapped(maxInstances, ["running"]);
}

function safeId(prefix: string, idx: number): string {
  return `${prefix}${idx}`.toLowerCase();
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const total = values.reduce((a, b) => a + b, 0);
  return total / values.length;
}

function sum(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((a, b) => a + b, 0);
}

type metricAggregation = {
  cpuAvg?: number;
  cpuCount?: number;
  netInTotal?: number;
  netInCount?: number;
  netOutTotal?: number;
  netOutCount?: number;
};

export async function getIdleMetricsForInstances(
  instanceIds: string[],
  lookbackDays: number,
  periodSeconds: number
): Promise<Record<string, idleMetrics>> {
  const endTime = new Date();
  const startTime = new Date(
    endTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000
  );

  const metricQueries: MetricDataQuery[] = [];

  instanceIds.forEach((instanceId, index) => {
    metricQueries.push({
      Id: safeId("cpu", index),
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: "CPUUtilization",
          Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        },
        Period: periodSeconds,
        Stat: "Average",
      },
    });

    metricQueries.push({
      Id: safeId("ni", index),
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: "NetworkIn",
          Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        },
        Period: periodSeconds,
        Stat: "Sum",
      },
    });

    metricQueries.push({
      Id: safeId("no", index),
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: "NetworkOut",
          Dimensions: [{ Name: "InstanceId", Value: instanceId }],
        },
        Period: periodSeconds,
        Stat: "Sum",
      },
    });
  });

  // CloudWatch GetMetricData allows up to 500 queries per request.
  const maxQueriesPerCall = 450;
  const queryChunks: MetricDataQuery[][] = [];
  for (let i = 0; i < metricQueries.length; i += maxQueriesPerCall) {
    queryChunks.push(metricQueries.slice(i, i + maxQueriesPerCall));
  }

  const aggregationByInstance: Record<string, metricAggregation> = {};

  function ensureAggregation(instanceId: string): metricAggregation {
    if (!aggregationByInstance[instanceId]) aggregationByInstance[instanceId] = {};
    return aggregationByInstance[instanceId];
  }

  const indexToInstanceId = instanceIds;

  for (const chunk of queryChunks) {
    let nextToken: string | undefined = undefined;

    do {
      const resp: GetMetricDataCommandOutput = await cloudWatchClient.send(
        new GetMetricDataCommand({
          StartTime: startTime,
          EndTime: endTime,
          MetricDataQueries: chunk,
          NextToken: nextToken,
          ScanBy: "TimestampAscending",
        })
      );

      for (const result of resp.MetricDataResults ?? []) {
        const queryId = result.Id ?? "";
        const values = (result.Values ?? []).filter(
          (v: number | undefined): v is number =>
            typeof v === "number" && Number.isFinite(v)
        );

        const match = queryId.match(/^(cpu|ni|no)(\d+)$/);
        if (!match) continue;

        const metricKind = match[1];
        const idx = Number(match[2]);

        if (!Number.isFinite(idx) || idx < 0 || idx >= indexToInstanceId.length) continue;

        const instanceId = indexToInstanceId[idx];
        const agg = ensureAggregation(instanceId);

        if (metricKind === "cpu") {
          agg.cpuAvg = average(values);
          agg.cpuCount = values.length;
        } else if (metricKind === "ni") {
          agg.netInTotal = sum(values);
          agg.netInCount = values.length;
        } else if (metricKind === "no") {
          agg.netOutTotal = sum(values);
          agg.netOutCount = values.length;
        }
      }

      nextToken = resp.NextToken;
    } while (nextToken);
  }

  const metricsByInstanceId: Record<string, idleMetrics> = {};

  for (const instanceId of instanceIds) {
    const agg = aggregationByInstance[instanceId] ?? {};
    metricsByInstanceId[instanceId] = {
      cpuAvg: agg.cpuAvg,
      netInBytesTotal: agg.netInTotal,
      netOutBytesTotal: agg.netOutTotal,
      dataPointsCpu: agg.cpuCount,
      dataPointsNetIn: agg.netInCount,
      dataPointsNetOut: agg.netOutCount,
    };
  }

  return metricsByInstanceId;
}

export function classifyIdle(
  inst: ec2InstanceSummary,
  metrics: idleMetrics,
  cpuThresholdPct: number,
  netTotalThresholdBytes: number,
  minDataPoints: number,
  excludeTagKeys: string[]
): idleCandidate {
  const reasons: string[] = [];

  const tags = inst.tags ?? {};
  const isExcludedByTag = excludeTagKeys.some((tagKey) => tagKey in tags);

  if (isExcludedByTag) {
    reasons.push(`Excluded (has one of these tag keys): ${excludeTagKeys.join(", ")}`);
  }

  const cpuPoints = metrics.dataPointsCpu ?? 0;
  const netInPoints = metrics.dataPointsNetIn ?? 0;
  const netOutPoints = metrics.dataPointsNetOut ?? 0;

  const hasEnoughMetricCoverage =
    cpuPoints >= minDataPoints &&
    netInPoints >= minDataPoints &&
    netOutPoints >= minDataPoints;

  if (!hasEnoughMetricCoverage) {
    reasons.push(
      `Low metric coverage (cpu=${cpuPoints}, netIn=${netInPoints}, netOut=${netOutPoints}; min=${minDataPoints}).`
    );
  }

  const cpuLooksIdle =
    typeof metrics.cpuAvg === "number" && metrics.cpuAvg <= cpuThresholdPct;

  const netTotalBytes = (metrics.netInBytesTotal ?? 0) + (metrics.netOutBytesTotal ?? 0);

  const networkLooksIdle =
    Number.isFinite(netTotalBytes) && netTotalBytes <= netTotalThresholdBytes;

  reasons.push(
    `CPU avg: ${metrics.cpuAvg?.toFixed(2) ?? "N/A"}% (threshold ${cpuThresholdPct}%)`
  );
  reasons.push(
    `Network total: ${Math.round(netTotalBytes)} bytes (threshold ${netTotalThresholdBytes} bytes)`
  );

  const idle = !isExcludedByTag && hasEnoughMetricCoverage && cpuLooksIdle && networkLooksIdle;

  let confidence: idleCandidate["confidence"] = "LOW";
  if (isExcludedByTag) confidence = "LOW";
  else if (hasEnoughMetricCoverage && cpuLooksIdle && networkLooksIdle) confidence = "HIGH";
  else if (hasEnoughMetricCoverage) confidence = "MEDIUM";

  return {
    ...inst,
    ...metrics,
    idle,
    confidence,
    reason: reasons,
  };
}
