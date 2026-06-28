# ctx - Context Switcher

Switch between GCP and Kubernetes contexts quickly.

## Usage

```bash
ctx [dev|staging|prod|eng|status]
```

## Examples

```bash
# Toggle between dev and staging
ctx

# Switch to production
ctx prod

# Show current context
ctx status
```

## When to use

- Switching between Jeenie environments
- Before running kubectl or gcloud commands
- Checking current active context
