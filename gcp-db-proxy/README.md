# Cloud SQL Database Connector

A set of bash scripts to securely connect to private Google Cloud SQL instances via bastion hosts and IAP tunneling.

## Overview

This tool establishes SSH tunnels through bastion VMs to connect to private Cloud SQL instances that don't have public IPs. It automatically:
- Creates and manages bastion VMs
- Generates SSL client certificates for database authentication
- Sets up IAP tunneling for secure access
- Provides connection strings for psql/DBeaver

## Prerequisites

- **gcloud CLI** - Google Cloud SDK must be installed and configured
- **Authentication** - Must be authenticated with `gcloud auth login`
- **Permissions** - Requires access to:
  - Cloud SQL instances
  - Compute Engine (for bastion VMs)
  - IAP (Identity-Aware Proxy)
- **Standard Unix tools** - bash, awk, grep, sed (typically pre-installed)

## Setup

1. **Configure your database(s)** in `configs.ini`:

```ini
[your-database-name]
project_id=your-gcp-project
instance_name=your-sql-instance
region=us-east1
zone=us-east1-b
bastion_name=sql-bastion
local_port=6665
db_name=your_database
db_user=your_user
```

2. **Make scripts executable** (if needed):
```bash
chmod +x connect_to_database verify_database_requirements
```

## Usage

### Verify Prerequisites

Before connecting, verify your environment is properly configured:

```bash
./verify_database_requirements <config-name>
```

Example:
```bash
./verify_database_requirements inventory-registrar
```

This checks:
- gcloud CLI installation and authentication
- Project access
- Cloud SQL instance existence
- Private network configuration
- Compute Engine permissions
- IAP enablement

### Connect to Database

Start an SSH tunnel to your database:

```bash
./connect_to_database <config-name>
```

Example:
```bash
./connect_to_database inventory-registrar
```

The script will:
1. Load configuration from `configs.ini`
2. Verify Cloud SQL instance network settings
3. Create/start bastion VM if needed
4. Generate SSL certificates if they don't exist
5. Establish SSH tunnel via IAP
6. Display connection instructions

**Keep the terminal open** - the tunnel runs in the foreground. Press `Ctrl+C` to close.

### Connect with psql

Once the tunnel is running, open a new terminal and connect:

**Using connection string:**
```bash
CERTS=~/.config/gcp-db-proxy/certs
psql "host=127.0.0.1 port=6665 user=your-user dbname=your-db sslmode=verify-ca sslcert=$CERTS/instance-name/client-cert.pem sslkey=$CERTS/instance-name/client-key.pem sslrootcert=$CERTS/instance-name/server-ca.pem"
```

**Using environment variables:**
```bash
export PGSSLCERT=~/.config/gcp-db-proxy/certs/inventory-registrar/client-cert.pem
export PGSSLKEY=~/.config/gcp-db-proxy/certs/inventory-registrar/client-key.pem
export PGSSLROOTCERT=~/.config/gcp-db-proxy/certs/inventory-registrar/server-ca.pem
psql -h 127.0.0.1 -p 6665 -U your-user -d your-database
```

### Connect with DBeaver

1. Create a new PostgreSQL connection
2. **Main** tab:
   - Host: `127.0.0.1`
   - Port: `6665` (or your configured `local_port`)
   - Database: (your `db_name`)
   - Username: (your `db_user`)
   - Password: (your password)
3. **SSL** tab:
   - Use SSL: `true`
   - CA certificate: `~/.config/gcp-db-proxy/certs/instance-name/server-ca.pem`
   - Client certificate: `~/.config/gcp-db-proxy/certs/instance-name/client-cert.pem`
   - Client private key: `~/.config/gcp-db-proxy/certs/instance-name/client-key.pem`
   - SSL mode: `verify-ca`

## Configuration

### Configuration File Format

`configs.ini` uses standard INI format with sections for each database:

```ini
# Comments are supported with #
[config-name]
project_id=solo-infrastructure       # GCP project ID
instance_name=inventory-registrar    # Cloud SQL instance name
region=us-east1                      # GCP region
zone=us-east1-b                      # Zone for bastion VM
bastion_name=sql-bastion             # Bastion VM name
local_port=6665                      # Local port for tunnel
db_name=inventory-registrar          # Database name
db_user=inventory-user               # Database username
```

### Adding New Databases

To add another database, simply add a new section to `configs.ini`:

```ini
[production-db]
project_id=prod-project
instance_name=prod-sql
region=us-central1
zone=us-central1-a
bastion_name=prod-bastion
local_port=6666
db_name=production
db_user=prod_user
```

Then use it:
```bash
./connect_to_database production-db
```

### List Available Configurations

```bash
source load_config.sh && list_configs
```

## Certificate Management

### SSL Certificates

Client SSL certificates are automatically generated and stored **outside the
repo** (never committed) in:
```
~/.config/gcp-db-proxy/certs/<instance-name>/
  ├── client-cert.pem
  ├── client-key.pem
  └── server-ca.pem
```

- Location overridable via `GCP_DB_PROXY_HOME` (or `XDG_CONFIG_HOME`)
- Certificates are **instance-specific** to prevent collisions
- Created automatically on first connection
- Reused on subsequent connections
- Stored in `.gitignore` for security

### Certificate Lifecycle

- **Creation**: Automatic on first run if certificates don't exist
- **Naming**: `client-cert-YYYYMMDD-HHMMSS` in Cloud SQL
- **Location**: `certs/<instance-name>/` directory
- **Reuse**: Certificates persist across connections

### Managing Certificates

**List certificates for an instance:**
```bash
gcloud sql ssl-certs list --instance=your-instance --project=your-project
```

**Delete a certificate:**
```bash
gcloud sql ssl-certs delete cert-name --instance=your-instance --project=your-project
```

**Regenerate certificates:**
```bash
rm -rf certs/your-instance/
# Run connect_to_database again to regenerate
```

## Troubleshooting

### "Error: Could not find private network for Cloud SQL instance"

- Verify the instance has private IP enabled
- Check that `settings.ipConfiguration.privateNetwork` is configured
- Run `./verify_database_requirements <config>` for detailed checks

### "Failed to lookup instance" when establishing tunnel

- The bastion VM may not be fully ready
- Wait 30-60 seconds and try again
- Check bastion status: `gcloud compute instances list`

### "Connection requires a valid client certificate"

- SSL certificates may be missing or invalid
- Regenerate: `rm -rf certs/<instance-name>/ && ./connect_to_database <config>`
- Verify Cloud SQL requires client certificates

### "pg_hba.conf rejects connection"

- Check that you're using `sslmode=verify-ca` (not `require` or `verify-full`)
- Verify the database user and database name are correct
- Check Cloud SQL authorized networks if using public IP

### Certificate hostname verification errors (DBeaver)

- In DBeaver, use `sslmode=verify-ca` in Driver properties
- This verifies the certificate but not the hostname
- Required because you're connecting to `localhost` but cert is for the SQL instance

## Architecture

### Connection Flow

```
Your Machine → Bastion VM (via IAP) → Cloud SQL Instance
   (localhost:6665)    (tunnel)         (private IP:5432)
```

1. **IAP Tunnel**: Secure tunnel to bastion VM without public IP
2. **SSH Port Forwarding**: Local port forwarded through bastion
3. **Private Network**: Bastion accesses SQL via private VPC network
4. **SSL Certificates**: Client cert authentication to PostgreSQL

### Bastion VM Details

- **Machine Type**: e2-micro (cost-effective)
- **Network**: Same VPC as Cloud SQL instance
- **IP**: No external IP (IAP tunnel only)
- **Tags**: `sql-bastion` for firewall rules
- **Lifecycle**: Created once, reused for subsequent connections

## Security Notes

- ✓ No public IPs on Cloud SQL instances
- ✓ Bastion has no external IP (IAP tunnel only)
- ✓ Client certificate authentication required
- ✓ Certificates stored locally, not in git
- ✓ IAP provides identity-based access control
- ⚠️ `configs.ini` is committed to git (contains infrastructure config, not secrets)
- ⚠️ Keep `certs/` directory secure (contains private keys)

## Files

```
.
├── README.md                      # This file
├── configs.ini                    # Database configurations
├── load_config.sh                 # Configuration loader library
├── connect_to_database            # Main connection script
├── verify_database_requirements   # Prerequisites checker
└── certs/                         # SSL certificates (gitignored)
    └── <instance-name>/
        ├── client-cert.pem
        ├── client-key.pem
        └── server-ca.pem
```

## Contributing

To add features or fix bugs:
1. Test changes with `./verify_database_requirements`
2. Verify both scripts work with multiple configs
3. Update this README with any new usage patterns

## License

Internal use only.
