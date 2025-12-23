@echo off
echo Starting Redis for local development...
docker-compose up -d redis
echo Redis started on localhost:6379
echo.
echo To stop Redis: docker-compose down
pause