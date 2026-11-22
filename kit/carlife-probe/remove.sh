#!/bin/sh
# carlife-probe 0.2.0 - undoing what install.sh did, by hand.
#
# The Store has no uninstall hook: run this before uninstalling the tool if the
# unit and the report directory are to go with it. Left behind, the unit is
# merely inactive once its script is gone.
set -u

systemctl disable --now carlife-probe.service 2>/dev/null
rm -f /etc/systemd/system/carlife-probe.service
systemctl daemon-reload 2>/dev/null
rm -rf /dev/shm/carlife-probe
# the payload under /var/opt/carlife-probe is the Store's, and goes with the tool
echo "carlife-probe: removed"
