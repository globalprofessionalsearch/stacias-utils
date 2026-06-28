#!/bin/bash

# Configuration loader for database connector scripts
# Parses configs.ini and exports configuration variables

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/configs.ini"

# Parse a value from a specific INI section
# Usage: parse_ini_value <section> <key>
parse_ini_value() {
    local section=$1
    local key=$2

    if [ ! -f "$CONFIG_FILE" ]; then
        echo "Error: Configuration file not found: $CONFIG_FILE" >&2
        return 1
    fi

    # Use awk to parse INI file
    awk -F= -v section="[$section]" -v key="$key" '
        # Remove leading/trailing whitespace from line
        { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); }

        # Skip empty lines and comments
        /^[[:space:]]*$/ { next }
        /^[[:space:]]*#/ { next }

        # Check if we entered the target section
        $0 == section { in_section=1; next }

        # Check if we entered a different section
        /^\[/ { in_section=0; next }

        # If in target section and key matches, print value
        in_section && $1 == key {
            # Print everything after the first =
            sub(/^[^=]+=/, "");
            print;
            exit
        }
    ' "$CONFIG_FILE"
}

# List all available configuration sections
# Usage: list_configs
list_configs() {
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "Error: Configuration file not found: $CONFIG_FILE" >&2
        return 1
    fi

    grep '^\[' "$CONFIG_FILE" | sed 's/\[\(.*\)\]/\1/'
}

# Check if a configuration exists
# Usage: config_exists <section>
config_exists() {
    local section=$1
    list_configs | grep -q "^${section}$"
}

# Load configuration and export variables
# Usage: load_config <config-name>
load_config() {
    local config_name=$1

    if [ -z "$config_name" ]; then
        echo "Error: No configuration name provided" >&2
        echo "" >&2
        echo "Usage: $0 <config-name>" >&2
        echo "" >&2
        echo "Available configurations:" >&2
        list_configs | sed 's/^/  - /' >&2
        return 1
    fi

    if ! config_exists "$config_name"; then
        echo "Error: Configuration '$config_name' not found in $CONFIG_FILE" >&2
        echo "" >&2
        echo "Available configurations:" >&2
        list_configs | sed 's/^/  - /' >&2
        return 1
    fi

    # Load all configuration values
    PROJECT_ID=$(parse_ini_value "$config_name" "project_id")
    INSTANCE_NAME=$(parse_ini_value "$config_name" "instance_name")
    REGION=$(parse_ini_value "$config_name" "region")
    ZONE=$(parse_ini_value "$config_name" "zone")
    BASTION_NAME=$(parse_ini_value "$config_name" "bastion_name")
    LOCAL_PORT=$(parse_ini_value "$config_name" "local_port")
    DB_NAME=$(parse_ini_value "$config_name" "db_name")
    DB_USER=$(parse_ini_value "$config_name" "db_user")

    # Validate required fields
    if [ -z "$PROJECT_ID" ] || [ -z "$INSTANCE_NAME" ] || [ -z "$ZONE" ]; then
        echo "Error: Configuration '$config_name' is missing required fields" >&2
        echo "Required: project_id, instance_name, zone" >&2
        return 1
    fi

    # Export variables for use in calling scripts
    export PROJECT_ID
    export INSTANCE_NAME
    export REGION
    export ZONE
    export BASTION_NAME
    export LOCAL_PORT
    export DB_NAME
    export DB_USER
    export CONFIG_NAME="$config_name"

    return 0
}
