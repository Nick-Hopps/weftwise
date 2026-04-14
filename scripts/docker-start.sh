#!/bin/sh
# Start both Next.js server and background worker.
# Under tini, SIGTERM is forwarded to all children.

# Start the Next.js server in background
node server.js &
WEB_PID=$!

# Start the worker in background
npx tsx src/server/worker-entry.ts &
WORKER_PID=$!

# Wait for either process to exit; if one dies, kill the other
wait -n $WEB_PID $WORKER_PID 2>/dev/null
EXIT_CODE=$?

echo "A process exited with code $EXIT_CODE, shutting down..."
kill $WEB_PID $WORKER_PID 2>/dev/null
wait
exit $EXIT_CODE
