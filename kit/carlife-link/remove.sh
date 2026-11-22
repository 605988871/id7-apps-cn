#!/bin/sh
# carlife-link 0.1.0 - undoing what install.sh did, by hand.
#
# The Store has no uninstall hook: run this before uninstalling the tool if the
# unit and the report directory are to go with it. Left behind, the unit is
# merely inactive once its binary is gone.
set -u

systemctl disable --now carlife-link.service 2>/dev/null
rm -f /etc/systemd/system/carlife-link.service
systemctl daemon-reload 2>/dev/null
rm -rf /dev/shm/carlife-wireless
# the payload under /var/opt/carlife-link is the Store's, and goes with the tool
echo "carlife-link: removed"
