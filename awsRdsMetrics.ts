import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Datapoint,
} from "@aws-sdk/client-cloudwatch";

function getRegion(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing AWS_REGION in environment");
  return region;
}

const cloudWatchClient = new CloudWatchClient({ region: getRegion() });

export type rdsCpuMetrics = {
  dbInstanceIdentifier: string;
  periodSeconds: number;
  datapoints: number;
  average?: number;
  minimum?: number;
  maximum?: number;
  latestTimestamp?: string;
  latestAverage?: number;
};

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function min(values: number[]): number | undefined {
  return values.length ? Math.min(...values) : undefined;
}

function max(values: number[]): number | undefined {
  return values.length ? Math.max(...values) : undefined;
}

function getLatest(datapoints: Datapoint[]): Datapoint | undefined {
  return datapoints
    .filter((dp) => dp.Timestamp instanceof Date)
    .sort((a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0))[0];
}

export async function getRdsCpuUtilization(
  dbInstanceIdentifier: string,
  lookbackHours: number,
  periodSeconds: number
): Promise<rdsCpuMetrics> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - lookbackHours * 60 * 60 * 1000);

  const response = await cloudWatchClient.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/RDS",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "DBInstanceIdentifier", Value: dbInstanceIdentifier }],
      StartTime: startTime,
      EndTime: endTime,
      Period: periodSeconds,
      Statistics: ["Average", "Minimum", "Maximum"],
    })
  );

  const datapoints = response.Datapoints ?? [];
  const averages = datapoints
    .map((dp) => dp.Average)
    .filter((value): value is number => typeof value === "number");
  const mins = datapoints
    .map((dp) => dp.Minimum)
    .filter((value): value is number => typeof value === "number");
  const maxes = datapoints
    .map((dp) => dp.Maximum)
    .filter((value): value is number => typeof value === "number");

  const latest = getLatest(datapoints);

  return {
    dbInstanceIdentifier,
    periodSeconds,
    datapoints: datapoints.length,
    average: average(averages),
    minimum: min(mins),
    maximum: max(maxes),
    latestTimestamp: latest?.Timestamp?.toISOString(),
    latestAverage: latest?.Average,
  };
}
