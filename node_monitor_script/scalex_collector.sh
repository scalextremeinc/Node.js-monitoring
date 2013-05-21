#!/bin/bash
#set -x
port=${1:-10010}
action=${2:-getadata}
curl "http://127.0.0.1:$port/node_monitor?action=$action&access_code=scalex"
