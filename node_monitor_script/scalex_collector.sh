#!/bin/bash
#set -x
port=${1:-10010}
curl "http://127.0.0.1:$port/node_monitor?action=getdata&access_code=scalex"
