# gcs-watch

Real-time GCS bucket monitoring with SMS alerts via Pub/Sub.

## Dependencies

```bash
pip install google-cloud-pubsub google-cloud-storage
```

## Setup

1. Ensure `gcloud` is configured with your project:
   ```bash
   gcloud config set project <project-id>
   ```

2. Ensure you have appropriate GCP permissions:
   - `pubsub.topics.create` / `pubsub.topics.delete`
   - `pubsub.subscriptions.create` / `pubsub.subscriptions.delete`
   - `storage.buckets.update` (for bucket notifications)

## Usage

```bash
gcs-watch gs://my-bucket 2539510932 verizon
```

## How It Works

1. **Startup**: Creates Pub/Sub topic + subscription, configures GCS bucket notification
2. **Monitoring**: Receives real-time events when objects are created
3. **Batching**: Groups notifications within 60s windows to avoid SMS spam
4. **Cleanup**: Removes all infrastructure on Ctrl-C

## Architecture

- **Topic**: `gcs-watch-stacias-utils-{bucket-hash}` (reused if exists)
- **Subscription**: 10-minute message retention, immediate ack (no durability)
- **Bucket notification**: Sends events to topic on object creation
- **SMS**: Via Gmail SMTP → carrier email-to-SMS gateway

Reuses existing topic/subscription on restart (drains old messages automatically).

## Cost

- Pub/Sub: ~$0.40 per million events (pennies for typical use)
- No cost for idle resources
- Much cheaper than polling with `gsutil ls -r`
