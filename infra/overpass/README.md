# Texas Overpass API

This deployable unit supplies the private, Overpass-compatible road source for
Property Explorer WDLL items 8–9. It imports the Texas Geofabrik PBF and serves
the exact `POST /api/interpreter` query shape used by
`artifacts/api-server/src/lib/buildableEnvelope/roads.ts`.

It intentionally does not enable `--enable-roads`. That bake flag remains
blocked until this endpoint is reachable from the bake environment and the
smoke query below returns highway ways.

## Source and behavior

The image configuration follows the upstream
[wiktorn/Overpass-API README](https://github.com/wiktorn/Overpass-API/blob/master/README.md):
`OVERPASS_MODE=init` downloads the configured extract and
`OVERPASS_PLANET_PREPROCESS` converts the Geofabrik PBF to the `.osm.bz2`
input required by the importer. The database is stored at `/db` on a durable
disk. Area generation is disabled because the only required query is
`way(...)[highway]`, not area lookup.

`OVERPASS_URL` must include `/api/interpreter`, for example:

```text
http://10.0.0.12:8080/api/interpreter
```

Do not expose this unauthenticated API publicly. The default bind address is
`127.0.0.1`. A GCE deployment changes it to `0.0.0.0` only behind a firewall
that admits the Cloud Run VPC connector source range and no public CIDRs.

## Local or VM import

On a Linux VM with Docker Compose:

```bash
cd infra/overpass
cp .env.example .env
mkdir -p data
docker compose up
```

The first start downloads and imports the Texas extract. The upstream image
stops after a successful initialization. Start it again to serve requests:

```bash
docker compose up -d
docker compose ps
./smoke.sh
```

`smoke.sh` posts the production-compatible highway-way query around downtown
Austin and exits nonzero unless at least one highway way with geometry returns.
It needs `curl` and `jq`.

## GCE deployment

These commands are an operator runbook, not commands executed by this PR.
They require a billing-enabled project, a selected region/zone, and a
Cloud Run VPC connector range. Replace all angle-bracket values.

```bash
export PROJECT_ID=<gcp-project-id>
export ZONE=us-central1-a
export VM=overpass-tx-01
export DISK=overpass-tx-data
export CONNECTOR_CIDR=<cloud-run-vpc-connector-cidr>

gcloud config set project "${PROJECT_ID}"
gcloud compute disks create "${DISK}" --zone="${ZONE}" --size=200GB --type=pd-ssd
gcloud compute instances create "${VM}" \
  --zone="${ZONE}" \
  --machine-type=e2-standard-8 \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-balanced \
  --disk=name="${DISK}",device-name=overpass-data,mode=rw,boot=no,auto-delete=no \
  --tags=overpass-private \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud

# The API is available only to the connector range on its internal VM address.
gcloud compute firewall-rules create allow-overpass-from-cloud-run \
  --network=default --direction=INGRESS --action=ALLOW --rules=tcp:8080 \
  --source-ranges="${CONNECTOR_CIDR}" --target-tags=overpass-private

gcloud compute ssh "${VM}" --zone="${ZONE}"
```

Inside the VM, format and mount the dedicated disk once, then install Docker
and run this directory:

```bash
sudo mkfs.ext4 -F /dev/disk/by-id/google-overpass-data
sudo mkdir -p /srv/overpass
echo '/dev/disk/by-id/google-overpass-data /srv/overpass ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker "$USER"
git clone https://github.com/empressaioemail-tech/legacy-design-tools.git /tmp/legacy-design-tools
sudo rsync -a /tmp/legacy-design-tools/infra/overpass/ /srv/overpass/app/
sudo chown -R "$USER":"$USER" /srv/overpass/app
cd /srv/overpass/app
cp .env.example .env
cat >>.env <<'EOF'
OVERPASS_DB_DIR=/srv/overpass/data
OVERPASS_BIND_ADDRESS=0.0.0.0
EOF
mkdir -p /srv/overpass/data
docker compose up
# After import exits successfully:
docker compose up -d
OVERPASS_URL=http://127.0.0.1:8080/api/interpreter ./smoke.sh
```

Record the VM's internal address after the smoke succeeds:

```bash
gcloud compute instances describe "${VM}" --zone="${ZONE}" \
  --format='get(networkInterfaces[0].networkIP)'
```

Then set the service/bake environment only after the Cloud Run VPC connector
can route to that internal address:

```bash
gcloud run services update cortex-api \
  --region=<cloud-run-region> \
  --update-env-vars=OVERPASS_URL=http://<vm-internal-ip>:8080/api/interpreter \
  --vpc-connector=<connector-name> \
  --vpc-egress=private-ranges-only
```

Verify from the same network path used by the service or bake:

```bash
OVERPASS_URL=http://<vm-internal-ip>:8080/api/interpreter ./smoke.sh
```

Only then may an operator run a bounded Tier-2 road bake, such as:

```bash
pnpm --filter @artifacts/api-server node-facet-bake-tier2 -- \
  --county=<fips> --limit=200 --enable-roads
```

## Refresh

This deployment deliberately has no diff-sync. For monthly or quarterly
refreshes, schedule a maintenance window, stop the service, replace the
`data/` directory with a fresh import, run the import once, start it again,
and re-run `smoke.sh`. The source date and smoke output belong in the coverage
ledger before a road-confidence claim advances.

## Operator holds

Before WDLL item 8 can be graded met, the operator must provide or authorize:

1. Billing-enabled GCP project, region/zone, and a durable persistent disk.
2. Cloud Run VPC connector name and CIDR, or an equivalent private network
   route from `cortex-api` and the bake runner to the VM.
3. Approval of the VM size and disk cost after the Texas import's observed disk
   use. The committed `200GB` is a starting configuration, not a verified
   post-import requirement.
4. A real smoke result from the private endpoint.

Until those observations exist, WDLL item 8 is scaffolded but blocked and
item 9 remains intentionally unstarted.
