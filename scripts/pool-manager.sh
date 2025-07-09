#!/bin/bash
# Otedama Pool management script

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
SERVICE_NAME="otedama-pool"
HEALTH_URL="http://localhost:3001/health"

# Functions
show_help() {
    echo "Otedama Pool Management Script"
    echo "Usage: $0 {start|stop|restart|status|logs|health|backup}"
    echo ""
    echo "Commands:"
    echo "  start    - Start the mining pool"
    echo "  stop     - Stop the mining pool"
    echo "  restart  - Restart the mining pool"
    echo "  status   - Show pool status"
    echo "  logs     - Show recent logs"
    echo "  health   - Check pool health"
    echo "  backup   - Create a backup"
}

start_pool() {
    echo -e "${GREEN}Starting Otedama Pool...${NC}"
    
    # Check if using systemd
    if command -v systemctl &> /dev/null && systemctl list-unit-files | grep -q "$SERVICE_NAME.service"; then
        sudo systemctl start $SERVICE_NAME
        echo "Started via systemd"
    # Check if using PM2
    elif command -v pm2 &> /dev/null; then
        pm2 start ecosystem.config.js
        echo "Started via PM2"
    else
        # Direct start
        npm run build && npm start &
        echo "Started directly (pid: $!)"
    fi
}

stop_pool() {
    echo -e "${YELLOW}Stopping Otedama Pool...${NC}"
    
    if command -v systemctl &> /dev/null && systemctl is-active --quiet $SERVICE_NAME; then
        sudo systemctl stop $SERVICE_NAME
        echo "Stopped via systemd"
    elif command -v pm2 &> /dev/null && pm2 list | grep -q "otedama-pool"; then
        pm2 stop otedama-pool
        echo "Stopped via PM2"
    else
        # Try to stop using PID file
        if [ -f "data/pool.pid" ]; then
            PID=$(cat data/pool.pid)
            if kill -0 $PID 2>/dev/null; then
                kill -TERM $PID
                echo "Sent SIGTERM to process $PID"
            else
                echo "Process not running"
            fi
        else
            echo "No PID file found"
        fi
    fi
}

restart_pool() {
    echo -e "${YELLOW}Restarting Otedama Pool...${NC}"
    stop_pool
    sleep 5
    start_pool
}

show_status() {
    echo -e "${BLUE}Otedama Pool Status${NC}"
    echo "==================="
    
    # Check systemd
    if command -v systemctl &> /dev/null && systemctl list-unit-files | grep -q "$SERVICE_NAME.service"; then
        echo -e "\n${YELLOW}Systemd Status:${NC}"
        systemctl status $SERVICE_NAME --no-pager || true
    fi
    
    # Check PM2
    if command -v pm2 &> /dev/null; then
        echo -e "\n${YELLOW}PM2 Status:${NC}"
        pm2 show otedama-pool 2>/dev/null || echo "Not running in PM2"
    fi
    
    # Check process
    echo -e "\n${YELLOW}Process Status:${NC}"
    if pgrep -f "otedama.*main.js" > /dev/null; then
        echo -e "${GREEN}Pool is running${NC}"
        ps aux | grep -E "otedama.*main.js" | grep -v grep
    else
        echo -e "${RED}Pool is not running${NC}"
    fi
    
    # Check ports
    echo -e "\n${YELLOW}Port Status:${NC}"
    for port in 3333 3001 8080 8081; do
        if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "Port $port: ${GREEN}LISTENING${NC}"
        else
            echo -e "Port $port: ${RED}NOT LISTENING${NC}"
        fi
    done
}

show_logs() {
    echo -e "${BLUE}Recent Logs${NC}"
    echo "==========="
    
    # Check journalctl (systemd)
    if command -v journalctl &> /dev/null && systemctl list-unit-files | grep -q "$SERVICE_NAME.service"; then
        echo -e "\n${YELLOW}Systemd logs:${NC}"
        sudo journalctl -u $SERVICE_NAME -n 50 --no-pager
    # Check PM2 logs
    elif command -v pm2 &> /dev/null; then
        echo -e "\n${YELLOW}PM2 logs:${NC}"
        pm2 logs otedama-pool --lines 50 --nostream
    # Check log files
    elif [ -d "logs" ]; then
        echo -e "\n${YELLOW}Log files:${NC}"
        if [ -f "logs/pool-$(date +%Y-%m-%d).log" ]; then
            tail -n 50 "logs/pool-$(date +%Y-%m-%d).log"
        else
            echo "No log file found for today"
        fi
    else
        echo "No logs found"
    fi
}

check_health() {
    echo -e "${BLUE}Health Check${NC}"
    echo "============"
    
    if curl -s -f $HEALTH_URL > /tmp/health.json; then
        echo -e "${GREEN}Health check passed${NC}"
        echo ""
        # Pretty print JSON if jq is available
        if command -v jq &> /dev/null; then
            cat /tmp/health.json | jq .
        else
            cat /tmp/health.json
        fi
    else
        echo -e "${RED}Health check failed${NC}"
        echo "Could not connect to $HEALTH_URL"
    fi
    
    rm -f /tmp/health.json
}

create_backup() {
    echo -e "${BLUE}Creating Backup${NC}"
    echo "==============="
    
    BACKUP_DIR="backups/manual-$(date +%Y%m%d-%H%M%S)"
    mkdir -p $BACKUP_DIR
    
    # Backup data directory
    if [ -d "data" ]; then
        echo "Backing up data directory..."
        tar -czf "$BACKUP_DIR/data.tar.gz" data/
    fi
    
    # Backup logs
    if [ -d "logs" ]; then
        echo "Backing up logs..."
        tar -czf "$BACKUP_DIR/logs.tar.gz" logs/
    fi
    
    # Backup configuration
    if [ -f ".env" ]; then
        echo "Backing up configuration..."
        cp .env "$BACKUP_DIR/.env.backup"
    fi
    
    echo -e "${GREEN}Backup created: $BACKUP_DIR${NC}"
}

# Main script
case "$1" in
    start)
        start_pool
        ;;
    stop)
        stop_pool
        ;;
    restart)
        restart_pool
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    health)
        check_health
        ;;
    backup)
        create_backup
        ;;
    *)
        show_help
        exit 1
        ;;
esac

exit 0
