import {
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
  type DBInstance,
  type DBSnapshot,
} from "@aws-sdk/client-rds";

const awsRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

function getRdsClient(): RDSClient {
  return new RDSClient({ region: awsRegion });
}

export type rdsInstanceSummary = {
  dbInstanceIdentifier: string;
  engine?: string;
  engineVersion?: string;
  instanceClass?: string;
  status?: string;
  endpointAddress?: string;
  endpointPort?: number;
  availabilityZone?: string;
  publiclyAccessible?: boolean;
  storageEncrypted?: boolean;
  multiAz?: boolean;
  allocatedStorageGb?: number;
  dbName?: string;
};

export type rdsInstanceDetails = rdsInstanceSummary & {
  arn?: string;
  masterUsername?: string;
  vpcId?: string;
  subnetGroupName?: string;
  preferredMaintenanceWindow?: string;
  preferredBackupWindow?: string;
  backupRetentionPeriodDays?: number;
};

export type rdsSnapshotSummary = {
  snapshotIdentifier?: string;
  dbInstanceIdentifier?: string;
  status?: string;
  snapshotType?: string;
  engine?: string;
  snapshotCreateTime?: string;
  allocatedStorageGb?: number;
};

function mapInstanceSummary(instance: DBInstance): rdsInstanceSummary {
  return {
    dbInstanceIdentifier: instance.DBInstanceIdentifier ?? "unknown",
    engine: instance.Engine,
    engineVersion: instance.EngineVersion,
    instanceClass: instance.DBInstanceClass,
    status: instance.DBInstanceStatus,
    endpointAddress: instance.Endpoint?.Address,
    endpointPort: instance.Endpoint?.Port,
    availabilityZone: instance.AvailabilityZone,
    publiclyAccessible: instance.PubliclyAccessible,
    storageEncrypted: instance.StorageEncrypted,
    multiAz: instance.MultiAZ,
    allocatedStorageGb: instance.AllocatedStorage,
    dbName: instance.DBName,
  };
}

function mapInstanceDetails(instance: DBInstance): rdsInstanceDetails {
  return {
    ...mapInstanceSummary(instance),
    arn: instance.DBInstanceArn,
    masterUsername: instance.MasterUsername,
    vpcId: instance.DBSubnetGroup?.VpcId,
    subnetGroupName: instance.DBSubnetGroup?.DBSubnetGroupName,
    preferredMaintenanceWindow: instance.PreferredMaintenanceWindow,
    preferredBackupWindow: instance.PreferredBackupWindow,
    backupRetentionPeriodDays: instance.BackupRetentionPeriod,
  };
}

function mapSnapshotSummary(snapshot: DBSnapshot): rdsSnapshotSummary {
  return {
    snapshotIdentifier: snapshot.DBSnapshotIdentifier,
    dbInstanceIdentifier: snapshot.DBInstanceIdentifier,
    status: snapshot.Status,
    snapshotType: snapshot.SnapshotType,
    engine: snapshot.Engine,
    snapshotCreateTime: snapshot.SnapshotCreateTime?.toISOString(),
    allocatedStorageGb: snapshot.AllocatedStorage,
  };
}

export async function listRdsInstancesSimple(
  maxInstances: number
): Promise<rdsInstanceSummary[]> {
  const client = getRdsClient();
  const results: rdsInstanceSummary[] = [];
  let marker: string | undefined;

  do {
    const response = await client.send(
      new DescribeDBInstancesCommand({
        Marker: marker,
        MaxRecords: Math.min(100, maxInstances - results.length),
      })
    );

    const instances = response.DBInstances ?? [];
    for (const instance of instances) {
      results.push(mapInstanceSummary(instance));
      if (results.length >= maxInstances) break;
    }

    marker = response.Marker;
  } while (marker && results.length < maxInstances);

  return results;
}

export async function getRdsInstanceDetails(
  dbInstanceIdentifier: string
): Promise<rdsInstanceDetails> {
  const client = getRdsClient();
  const response = await client.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceIdentifier })
  );

  const instance = response.DBInstances?.[0];
  if (!instance) {
    throw new Error("DBInstanceNotFound");
  }

  return mapInstanceDetails(instance);
}

export async function listRdsSnapshotsSimple(
  dbInstanceIdentifier: string | undefined,
  maxSnapshots: number
): Promise<rdsSnapshotSummary[]> {
  const client = getRdsClient();
  const results: rdsSnapshotSummary[] = [];
  let marker: string | undefined;

  do {
    const response = await client.send(
      new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: dbInstanceIdentifier,
        Marker: marker,
        MaxRecords: Math.min(100, maxSnapshots - results.length),
      })
    );

    const snapshots = response.DBSnapshots ?? [];
    for (const snapshot of snapshots) {
      results.push(mapSnapshotSummary(snapshot));
      if (results.length >= maxSnapshots) break;
    }

    marker = response.Marker;
  } while (marker && results.length < maxSnapshots);

  return results;
}
