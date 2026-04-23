#!/bin/bash
cd "$(dirname "$0")"

echo "Arrancando Yagüi Nodo..."

# Matar procesos previos si los hay
pkill -f "node index.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

# Arrancar servidor Node
node index.js 2>&1 | tee /tmp/yagui-node.log &
NODE_PID=$!
sleep 2

# Verificar que el servidor responde
if ! curl -s http://localhost:3000/health > /dev/null; then
  echo "ERROR: el servidor no arrancó correctamente"
  exit 1
fi

# Arrancar túnel named (URL permanente — no necesita actualizar Supabase)
/tmp/cloudflared tunnel --config /home/marin/micelio-comerciante/nodo-server/tunnel-config.yml run &
sleep 5

PRODUCTOS=$(curl -s http://localhost:3000/health | python3 -c "import sys,json; print(json.load(sys.stdin)['productos'])" 2>/dev/null || echo "?")

echo ""
echo "================================"
echo "  Yagüi Nodo — ACTIVO ✓"
echo "================================"
echo "  Local:      http://localhost:3000"
echo "  Túnel:      https://nodo1.xn--yagi-2ra.com"
echo "  Productos:  ${PRODUCTOS} en inventario"
echo "================================"
echo "  Cierra esta ventana para parar"
echo ""

echo "── Logs en vivo ──────────────────"
tail -f /tmp/yagui-node.log
