#!/bin/bash

# Usage: bash systemd/install_docker_compose_service.bash /etc/systemd/system

services_dir=$1
service_name=whereplane-docker
service_filename=$services_dir/$service_name.service

# Text Colors
color_red='\033[0;31m'
color_nc='\033[0m' # No Color

if [ ! -d $services_dir ]; then
    echo -e "${color_red}Services directory $services_dir is not a valid directory.${color_nc}"
    exit
fi

docker_compose_filename=$(realpath $(dirname "$0")/../compose.yml)

cat > $services_dir/$service_name.service << endmsg

[Unit]
Description=Website services for whereplane.xyz.
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c "docker compose -f $docker_compose_filename up --detach"
ExecStop=/bin/bash -c "docker compose -f $docker_compose_filename stop"
Restart=on-failure

[Install]
WantedBy=multi-user.target

endmsg

if [ ! -e $service_filename ]; then
    echo -e "${color_red}Failed to create service file $service_filename. Try with sudo?${color_nc}"
    exit
else
    echo -e "Service file created at $service_filename."
fi