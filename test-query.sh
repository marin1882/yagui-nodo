#!/bin/bash
BARCODE=${1:-"6915993303714"}
API_KEY="9e5e62cf-7bff-4461-8eaf-53aa6a54e25b"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxib3pmYnZlbmNoeWFmeWloeXNvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzM5NTEsImV4cCI6MjA5MTc0OTk1MX0.4RwMzeCPHKHX6B4WGH8S3yQHXFwmqKzCo6u8sL37ddQ"

echo "Emitiendo token para barcode: $BARCODE"
TOKEN=$(curl -s -X POST \
  https://lbozfbvenchyafyihyso.supabase.co/functions/v1/emitir-token \
  -H "x-micelio-key: $API_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"nodo_id\":\"1\",\"query_type\":\"product\",\"barcode\":\"$BARCODE\"}" | jq -r .token)

echo "Token: $TOKEN"
echo "Consultando gateway..."

curl -s -X POST https://xn--yagi-2ra.com/query \
  -H "x-yagui-token: $TOKEN" \
  -H "Content-Type: application/json" | jq .
