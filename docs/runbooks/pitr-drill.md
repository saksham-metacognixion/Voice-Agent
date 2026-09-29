# RDS point-in-time restore drill

§17 promises "Postgres PITR 7 days"; ADR 0016 moved the database to RDS inside the backend
stack (`BackupRetentionPeriod: 7`). This drill proves the promise on staging: restore to a
chosen second into a **throwaway instance**, show that everything committed before that
second is there and that the copy is usable by the application, then delete it. The live
instance is never touched. It replaces the Neon drill the D14 brief names; Neon is gone.

Run it as `voice-agent-devs` (or anyone with `rds:RestoreDBInstanceToPointInTime`,
`rds:DeleteDBInstance`, `rds:Describe*`, `secretsmanager:GetSecretValue`, `ssm:StartSession`)
from a laptop with the AWS CLI, `session-manager-plugin`, `psql` and `jq`. About 30 minutes,
most of it waiting for RDS. It costs one `db.t4g.micro`-hour.

Record every timestamp in the table at the end: the restore time against the last restorable
time is the RPO you measured, command-to-available is the RTO.

## 0. Names

```sh
export AWS_REGION=ca-central-1
SRC=voice-agent-staging                 # DBInstanceIdentifier (backend-stack.yaml)
DRILL=voice-agent-staging-pitr-drill    # the throwaway copy
INSTANCE=i-0f90a16bb513e2d6d            # the staging EC2 instance (the only host that can reach RDS)

# Owner connection string from an RDS-managed secret, for a tunnel on local port $2.
owner_url() {
  aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text |
    jq -r --arg port "$2" '"postgresql://" + .username + ":" + (.password|@uri) + "@localhost:" + $port + "/portal?sslmode=require"'
}
```

Read what the copy must share with the source (subnet group, security group, class):

```sh
aws rds describe-db-instances --db-instance-identifier $SRC --query 'DBInstances[0].{
  endpoint:Endpoint.Address, subnets:DBSubnetGroup.DBSubnetGroupName,
  sg:VpcSecurityGroups[0].VpcSecurityGroupId, class:DBInstanceClass,
  secret:MasterUserSecret.SecretArn, latest:LatestRestorableTime}'
```

Keep `endpoint`, `subnets`, `sg`, `class` and `secret`. `latest` is how far behind the
continuous backup runs (typically five minutes).

## 1. Fingerprint the live database at a cut-off

Tunnel to the live instance (terminal 1, leave it open):

```sh
aws ssm start-session --target $INSTANCE \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<endpoint>"],"portNumber":["5432"],"localPortNumber":["55432"]}'
```

Terminal 2. Pick a cut-off a minute in the past, in a quiet minute, and fingerprint:

```sh
OWNER=$(owner_url <secret> 55432)
CUTOFF=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)      # GNU date: date -u -d '1 minute ago' +%Y-%m-%dT%H:%M:%SZ
echo "$CUTOFF"
infra/scripts/pitr-fingerprint.sh "$OWNER" "$CUTOFF" > ~/pitr-live.txt
grep -c . ~/pitr-live.txt
```

The file lists rows per never-deleted table at the cut-off, every workspace's ledger balance,
orphan counts, applied migrations, RLS per table, the policy count, the four append-only /
immutability triggers and the two application roles. Ask for `latest` again (step 0) and
wait until it is past `CUTOFF` before step 2.

## 2. Restore to the cut-off

```sh
T0=$(date -u +%FT%TZ)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier $SRC \
  --target-db-instance-identifier $DRILL \
  --restore-time "$CUTOFF" \
  --db-subnet-group-name <subnets> \
  --vpc-security-group-ids <sg> \
  --db-instance-class <class> \
  --no-publicly-accessible --no-multi-az \
  --no-deletion-protection \
  --manage-master-user-password \
  --tags Key=purpose,Value=pitr-drill Key=project,Value=voice-agent
aws rds wait db-instance-available --db-instance-identifier $DRILL
T1=$(date -u +%FT%TZ); echo "restore started $T0, available $T1"
```

`--manage-master-user-password` gives the copy its **own** master secret, so nothing about the
live instance's secret changes. Same security group, so the EC2 instance can reach it and
nothing else can.

```sh
aws rds describe-db-instances --db-instance-identifier $DRILL \
  --query 'DBInstances[0].{endpoint:Endpoint.Address, secret:MasterUserSecret.SecretArn}'
```

## 3. Verify the copy

Close the first tunnel; open one to the copy on another port (terminal 1):

```sh
aws ssm start-session --target $INSTANCE \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<drill endpoint>"],"portNumber":["5432"],"localPortNumber":["55433"]}'
```

Terminal 2:

```sh
DRILL_OWNER=$(owner_url <drill secret> 55433)
infra/scripts/pitr-fingerprint.sh "$DRILL_OWNER" "$CUTOFF" > ~/pitr-restored.txt
diff ~/pitr-live.txt ~/pitr-restored.txt && echo "IDENTICAL: every row, balance and structure at $CUTOFF"
```

**Pass** = `diff` prints nothing. A difference of one row in `calls` or `audit_log` whose
`created_at` is within a second of `CUTOFF` is a transaction that straddled it, not loss;
anything else is a failed drill.

Then prove the **application** can use the copy — its own role, with RLS still enforced.
The roles are cluster objects, so they come back with the same passwords. Take `DATABASE_URL`
from the environment file outside the repo (`~/voice-agent.staging.env`, written by
`db-env-roles.sh`) and point it at the tunnel:

```sh
APP=$(grep '^DATABASE_URL=' ~/voice-agent.staging.env | cut -d= -f2- | sed -E 's#@[^/]+/#@localhost:55433/#')
psql "$APP" -Atc "select current_user, count(*) from tenants"            # portal_app|0  (RLS: no app.tenant_id)
WS=$(psql "$DRILL_OWNER" -Atc "select tenant_id from calls group by 1 order by count(*) desc limit 1")
psql "$APP" -Atc "begin; select set_config('app.tenant_id','$WS',true); select count(*) from calls; rollback"   # > 0
psql "$APP" -c "update credit_ledger set delta = 0 where false"          # ERROR: permission denied — append-only held
```

## 4. Delete the copy

```sh
aws rds delete-db-instance --db-instance-identifier $DRILL \
  --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier $DRILL
```

Its secret is removed with it (managed master password). Close the tunnel. Delete
`~/pitr-*.txt` once the result is recorded; they hold workspace ids and balances.

## 5. Record

| Field                                  | Value |
| -------------------------------------- | ----- |
| Date, operator                         |       |
| `LatestRestorableTime` lag at step 0   |       |
| Cut-off (`CUTOFF`)                     |       |
| Restore started → available (RTO)      |       |
| Rows compared (`grep -c ^rows`)        |       |
| Workspace balances compared            |       |
| `diff` result                          |       |
| App role connects, RLS enforced        |       |
| Append-only refused on the copy        |       |
| Copy deleted at                        |       |

## Restoring for real

The same command, but the copy **becomes** the database: restore to the second before the
incident, verify as in step 3, then point the application at it — the host is in SSM
(`DATABASE_URL`, `ADMIN_DATABASE_URL`, `DIRECT_DATABASE_URL`), so `ssm-put-env.sh` with the new
host and `infra/scripts/deploy.sh staging <current tag>` swaps it over. Retire the damaged
instance only after `/health/ready` is 200 on the copy. CloudFormation still owns the
original, so bring the template in line (import the restored instance, or rename the damaged
one and restore into the original identifier) before the next stack update.
